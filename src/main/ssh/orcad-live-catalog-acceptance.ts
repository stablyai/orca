import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import type { createLiveOrcadProcess } from '../orcad/orcad-live-process-fixture'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import type { LiveCatalogSourcePaths } from './orcad-live-catalog-paths-fixture'
import { createStore, testState } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { installLiveSourceModel } from './orcad-live-source-model-fixture'
import { createLiveCatalogSource } from './orcad-live-catalog-source-fixture'
import { startSelectedOrcadLiveMigration } from './orcad-live-migration-start'
import { SshConnectionStore } from './ssh-connection-store'
import { getSshTargetRegistryStore, setSshTargetRegistryStore } from './ssh-target-registry'
import { ptyOwnership, ptyIncarnationById } from '../ipc/pty/provider/ownership-state'
import {
  addEnvironmentFromPairingCode,
  markEnvironmentUsed
} from '../../shared/runtime-environment-store'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import * as remoteClient from '../../shared/remote-runtime-client'
import { PTY_CAPTURED_DESTINATION_PREPARE_METHOD } from '../../shared/pty-ownership-transfer-runtime-methods'
import { OrcadLiveCutoverIntentStore } from './orcad-live-cutover-intent-store'

export type LiveCatalogMigrationHost = {
  directory: string
  sourceDirectory: string
  targetConnection?: { host: string; port: number; username: string }
  connectSource(): Promise<SshChannelMultiplexer>
  prepareCatalog?(): Promise<LiveCatalogSourcePaths>
  reconnectClient?(assertDisconnected: () => Promise<void>): Promise<void>
  destination: Pick<ReturnType<typeof createLiveOrcadProcess>, 'start' | 'stop' | 'rpc'>
  dispose(): Promise<void>
}

export async function verifyLiveCatalogMigration(options: {
  host: LiveCatalogMigrationHost
  lostPublication: number
  restartBeforeRetry: boolean
  unsupportedPeer: string
}): Promise<void> {
  const { host, lostPublication, restartBeforeRetry, unsupportedPeer } = options
  const { destination } = host
  const previousTargets = getSshTargetRegistryStore()
  let source: ReturnType<typeof installLiveSourceModel> | undefined
  let catalog: Awaited<ReturnType<typeof createLiveCatalogSource>> | undefined
  let mux: SshChannelMultiplexer | undefined
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
  const request = remoteClient.sendRemoteRuntimeRequest
  let publications = 0
  let replyLost = false
  const diagnostic = vi
    .spyOn(remoteClient, 'sendRemoteRuntimeRequest')
    .mockImplementation(async (...args) => {
      const result = await request(...args)
      if (!result.ok) {
        console.error('Fixture remote request refused', args[1], result.error)
      }
      if (result.ok && args[1] === PTY_CAPTURED_DESTINATION_PREPARE_METHOD) {
        publications++
        if (!replyLost && publications === lostPublication) {
          replyLost = true
          throw new Error('fixture_publication_reply_lost')
        }
      }
      return result
    })
  try {
    mux = await host.connectSource()
    const serving = await destination.start()
    testState.dir = join(host.directory, 'desktop')
    mkdirSync(testState.dir)
    const store = createStore()
    const runtime = new OrcaRuntimeService(store, undefined, { runtimeId: 'desktop' })
    const targetId = randomUUID()
    store.addSshTarget({
      id: targetId,
      label: 'Private catalog source',
      host: 'localhost',
      port: 22,
      username: 'fixture',
      ...host.targetConnection,
      generation: 1
    })
    setSshTargetRegistryStore(new SshConnectionStore(store))
    addEnvironmentFromPairingCode(testState.dir, {
      id: 'destination',
      name: 'Destination',
      pairingCode: serving.pairing.url
    })
    markEnvironmentUsed(testState.dir, 'destination', { runtimeId: serving.runtimeId })
    const clientInstanceId = randomUUID()
    const grant = (await mux.request('pty.openClient', {
      protocolVersion: 1,
      clientInstanceId,
      requestedRole: 'session-owner',
      capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 1024 } }
    })) as {
      ownerLease: string
      ownerGeneration: number
      clientGeneration: number
      serverBuildId: string
    }
    source = installLiveSourceModel(runtime, mux, targetId, grant)
    catalog = await createLiveCatalogSource({
      directory: host.sourceDirectory,
      ...(host.prepareCatalog ? { paths: await host.prepareCatalog() } : {}),
      store,
      runtime,
      source,
      targetId,
      owner: { ...grant, clientInstanceId }
    })
    const terminals = catalog.terminals
    expect(terminals).toHaveLength(2)
    expect(terminals.map(({ workspaceKey }) => workspaceKey.split(':')[0]).sort()).toEqual([
      'folder',
      'worktree'
    ])
    const pids = new Map<string, string>()
    for (const terminal of terminals) {
      source.provider.write(
        terminal.ptyId,
        'stty -echo; ORCA_CATALOG_VALUE=retained; printf "\\nBEFORE:%s:%s\\n" "$$" "$ORCA_CATALOG_VALUE"\n'
      )
      await vi.waitFor(
        async () => {
          await source!.drain()
          expect(source!.errors).toEqual([])
          const buffer = (await runtime.serializeMainTerminalBuffer(terminal.ptyId))?.data ?? ''
          const match = buffer.match(/BEFORE:(\d+):retained/)
          expect(match).not.toBeNull()
          pids.set(terminal.handle, match![1])
        },
        { timeout: 5000 }
      )
    }
    expect(await destination.rpc('repo.list', {})).toMatchObject({ repos: [] })
    console.info('Beginning whole-catalog migration with two live shells')
    const start = () =>
      startSelectedOrcadLiveMigration(
        testState.dir,
        { store, runtime },
        { selector: 'destination', targetId },
        AbortSignal.timeout(120_000)
      )
    if (unsupportedPeer !== 'none') {
      await expect(start()).rejects.toThrow(`${unsupportedPeer}_preflight_unsupported`)
      expect(new OrcadLiveCutoverIntentStore(testState.dir).list()).toEqual([])
      expect(store.listOrcadMigrationSourceCutovers()).toEqual([])
      expect(store.getSshTarget(targetId)?.owner).toBeUndefined()
      expect(publications).toBe(0)
      for (const terminal of terminals) {
        expect(ptyOwnership.get(terminal.ptyId)).toBe(targetId)
        source.provider.write(terminal.ptyId, 'printf "\\nPREFLIGHT_REFUSED:%s\\n" "$$"\n')
        await vi.waitFor(
          async () => {
            await source!.drain()
            const buffer = (await runtime.serializeMainTerminalBuffer(terminal.ptyId))?.data ?? ''
            expect(buffer).toContain(`PREFLIGHT_REFUSED:${pids.get(terminal.handle)}`)
          },
          { timeout: 5000 }
        )
      }
      return
    }
    let retained: ReturnType<OrcadLiveCutoverIntentStore['list']>[number] | undefined
    if (lostPublication) {
      await expect(start()).rejects.toThrow('fixture_publication_reply_lost')
      expect(replyLost).toBe(true)
      const intents = new OrcadLiveCutoverIntentStore(testState.dir).list()
      expect(intents).toHaveLength(1)
      retained = intents[0]
      expect(retained.liveTerminalBindings).toHaveLength(2)
      expect(
        store.getOrcadMigrationSourceCutover(retained.manifest.migrationId)?.terminalPublications ??
          []
      ).toHaveLength(lostPublication - 1)
      for (const terminal of terminals) {
        expect(ptyOwnership.get(terminal.ptyId)).toBe(targetId)
      }
      if (restartBeforeRetry) {
        await destination.stop('SIGKILL')
        expect((await destination.start()).runtimeId).toBe(serving.runtimeId)
      }
    }
    const progress = await start()
    if (retained) {
      expect(progress.migrationId).toBe(retained.manifest.migrationId)
      expect(new OrcadLiveCutoverIntentStore(testState.dir).list()).toEqual([retained])
    }
    expect(progress).toMatchObject({
      sourceRetirement: 'complete',
      phase: 'source-retired',
      receipts: { recorded: 2, total: 2 }
    })
    const completed = store.getOrcadMigrationSourceCutover(progress.migrationId)!
    expect(completed.phase).toBe('source-retired')
    expect(store.isOrcadLiveCompletionDurable(completed)).toBe(true)
    expect(createStore().getOrcadMigrationSourceCutover(progress.migrationId)).toEqual(completed)
    for (const terminal of terminals) {
      expect(ptyOwnership.has(terminal.ptyId)).toBe(false)
      expect(ptyIncarnationById.has(terminal.ptyId)).toBe(false)
    }
    expect(await destination.rpc('repo.list', {})).toMatchObject({
      repos: expect.arrayContaining([expect.objectContaining({ id: catalog.repoId })])
    })
    expect(await destination.rpc('folderWorkspace.list', {})).toMatchObject({
      folderWorkspaces: expect.arrayContaining([expect.objectContaining({ id: catalog.folderId })])
    })
    expect(await destination.rpc('projectGroup.list', {})).toMatchObject({
      groups: expect.arrayContaining([expect.objectContaining({ id: catalog.groupId })])
    })
    const read = async (handle: string) => {
      const result = (await destination.rpc('terminal.read', {
        terminal: handle,
        screen: true,
        limit: 1000
      })) as { terminal: { tail: string[] } }
      return result.terminal.tail.map((line) => line.trim())
    }
    const verify = async (marker: string) => {
      await vi.waitFor(
        async () => {
          const listed = (await destination.rpc('terminal.list', {
            requireFreshPtyLiveness: true,
            includeVisualLayouts: false
          })) as { terminals: unknown[] }
          expect(listed.terminals).toHaveLength(2)
          for (const terminal of terminals) {
            expect(listed.terminals).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  handle: terminal.handle,
                  ptyId: terminal.identity.terminalId,
                  incarnationId: terminal.identity.incarnationId,
                  connected: true,
                  writable: true
                })
              ])
            )
          }
        },
        { timeout: 45_000 }
      )
      for (const terminal of terminals) {
        const sent = await destination.rpc('terminal.send', {
          terminal: terminal.handle,
          text: `printf "\\n${marker}:%s:%s\\n" "$$" "$ORCA_CATALOG_VALUE"`,
          enter: true
        })
        expect(sent).toMatchObject({ send: { accepted: true } })
        await vi.waitFor(
          async () => {
            const lines = await read(terminal.handle)
            expect(
              lines.filter((line) => line === `BEFORE:${pids.get(terminal.handle)}:retained`)
            ).toHaveLength(1)
            expect(
              lines.filter((line) => line === `${marker}:${pids.get(terminal.handle)}:retained`)
            ).toHaveLength(1)
          },
          { timeout: 15_000 }
        )
      }
    }
    await verify('MIGRATED')
    source.dispose()
    source = undefined
    mux.dispose()
    if (host.reconnectClient) {
      await host.reconnectClient(async () => {
        await expect(destination.rpc('terminal.list', {})).rejects.toThrow()
      })
      await verify('RECONNECTED')
    }
    console.info('Whole-catalog migration verified; restarting destination')
    await destination.stop('SIGKILL')
    expect((await destination.start()).runtimeId).toBe(serving.runtimeId)
    await verify('RESTARTED')
    for (const terminal of terminals) {
      await destination.rpc('terminal.close', { terminal: terminal.handle })
    }
  } catch (error) {
    console.error('Whole-catalog acceptance failed before cleanup', error)
    throw error
  } finally {
    try {
      await destination.stop()
    } finally {
      catalog?.cleanupRoutes()
      source?.dispose()
      mux?.dispose()
      setSshTargetRegistryStore(previousTargets)
      vi.unstubAllEnvs()
      diagnostic.mockRestore()
      await host.dispose()
    }
  }
}
