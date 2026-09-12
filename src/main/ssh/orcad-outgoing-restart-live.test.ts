import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startLiveRelayDaemon } from '../../relay/relay-live-daemon-fixture'
import { createLiveOrcadProcess } from '../orcad/orcad-live-process-fixture'
import { connectOrcadLocalRelay } from '../orcad/orcad-local-relay-connection'
import { createStore, testState } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { installLiveSourceModel } from './orcad-live-source-model-fixture'
import { prepareOutgoingOrcadTerminalFromProvider } from './orcad-outgoing-terminal-preparation'
import { PTY_OWNERSHIP_CAPTURE_METHODS } from '../../shared/pty-ownership-capture-wire'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'
import { recoverSelectedOutgoingOrcadCapture } from './orcad-outgoing-recovery-selection'
import { SshConnectionStore } from './ssh-connection-store'
import { getSshTargetRegistryStore, setSshTargetRegistryStore } from './ssh-target-registry'
import {
  addEnvironmentFromPairingCode,
  markEnvironmentUsed
} from '../../shared/runtime-environment-store'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import {
  seedLiveOrcadRestoredWorker,
  readLiveOrcadSleepingWorker
} from './orcad-restored-worker-live-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
const relayEntry = process.env.ORCA_TEST_RELAY_ENTRY
const bun = process.env.ORCA_TEST_BUN_RUNTIME
const orcadEntry = process.env.ORCA_TEST_ORCAD_ENTRY

it
  .skipIf(!relayEntry || !bun || !orcadEntry || process.platform === 'win32')
  .each(['available', 'unavailable'] as const)(
  'recovers a captured native shell through a separate packaged orcad restart with source %s',
  async (sourceAtRestart) => {
    const daemon = await startLiveRelayDaemon(relayEntry!, bun!, [
      '--enable-ownership-transfer-mutation',
      '--enable-delegated-ownership-capture'
    ])
    const destinationDirectory = join(daemon.directory, 'destination')
    const destination = createLiveOrcadProcess(orcadEntry!, destinationDirectory)
    const previousTargets = getSshTargetRegistryStore()
    let source: ReturnType<typeof installLiveSourceModel> | undefined
    let mux: Awaited<ReturnType<typeof connectOrcadLocalRelay>> | undefined
    let endpointHidden = false
    const hiddenEndpoint = `${daemon.endpoint}.unavailable`
    vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
    try {
      // Keep the empty relay from retiring while packaged browser discovery runs.
      mux = await connectOrcadLocalRelay({ ...daemon, initialize: () => {} })
      const serving = await destination.start()
      expect(destination.startupDurationMs()).toBeLessThan(30_000)
      console.info('Packaged destination ready; beginning native capture')
      const workspace = join(daemon.directory, 'workspace')
      mkdirSync(workspace)
      const { group } = (await destination.rpc('projectGroup.create', {
        name: 'Native capture restart',
        parentPath: daemon.directory
      })) as { group: { id: string } }
      const { folderWorkspace } = (await destination.rpc('folderWorkspace.create', {
        projectGroupId: group.id,
        folderPath: workspace
      })) as { folderWorkspace: { id: string } }
      const workspaceKey = `folder:${folderWorkspace.id}` as const
      testState.dir = join(daemon.directory, 'desktop')
      mkdirSync(testState.dir)
      const store = createStore()
      const runtime = new OrcaRuntimeService(store, undefined, { runtimeId: 'desktop' })
      const targetId = randomUUID()
      store.addSshTarget({
        id: targetId,
        label: 'Private source',
        host: 'localhost',
        port: 22,
        username: 'fixture',
        generation: 1
      })
      setSshTargetRegistryStore(new SshConnectionStore(store))
      addEnvironmentFromPairingCode(testState.dir, {
        id: 'destination',
        name: 'Destination',
        pairingCode: serving.pairing.url
      })
      markEnvironmentUsed(testState.dir, 'destination', { runtimeId: serving.runtimeId })
      const grant = (await mux.request('pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: randomUUID(),
        requestedRole: 'session-owner',
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 1024 } }
      })) as { ownerLease: string; ownerGeneration: number }
      source = installLiveSourceModel(runtime, mux, targetId, grant)
      const sourceTerminalHandle = `term_${randomUUID()}`
      const spawned = await source.provider.spawn({
        cwd: workspace,
        shellOverride: '/bin/sh',
        cols: 80,
        rows: 24,
        env: { PS1: '', ENV: '/dev/null', ORCA_TERMINAL_HANDLE: sourceTerminalHandle }
      })
      const sourceIdentity = source.provider.getOwnershipTransferSourceIdentity(spawned.id)!
      const surfaceBinding = {
        executionHostId: 'local',
        workspaceKey,
        tabId: randomUUID(),
        leafId: randomUUID(),
        ptyId: sourceIdentity.terminalId
      }
      runtime.registerPty(spawned.id, workspaceKey, targetId, {
        tabId: surfaceBinding.tabId,
        leafId: surfaceBinding.leafId,
        incarnationId: spawned.incarnationId
      })
      source.ready()
      source.provider.write(
        spawned.id,
        'stty -echo; ORCA_RESTART_VALUE=retained; printf "\\nBEFORE:%s:%s\\n" "$$" "$ORCA_RESTART_VALUE"\n'
      )
      await vi.waitFor(
        async () => {
          await source!.drain()
          expect(source!.errors).toEqual([])
          expect((await runtime.serializeMainTerminalBuffer(spawned.id))?.data).toMatch(
            /BEFORE:\d+:retained/
          )
        },
        { timeout: 5000 }
      )
      const preparationArgs = {
        selector: 'destination',
        ptyId: spawned.id,
        surfaceBinding,
        runtime,
        signal: new AbortController().signal
      }
      if (sourceAtRestart === 'unavailable') {
        const request = source.provider.requestHostRpc.bind(source.provider)
        const intercept = vi.spyOn(source.provider, 'requestHostRpc')
        intercept.mockImplementation(async (method, params, options) => {
          if (method === PTY_OWNERSHIP_CAPTURE_METHODS.select) {
            throw new Error('source selection request interrupted')
          }
          return request(method, params, options)
        })
        try {
          await expect(
            prepareOutgoingOrcadTerminalFromProvider(testState.dir, preparationArgs)
          ).rejects.toThrow('source selection request interrupted')
        } finally {
          intercept.mockRestore()
        }
      } else {
        await prepareOutgoingOrcadTerminalFromProvider(testState.dir, preparationArgs)
      }
      const saved = new OrcadOutgoingCaptureStore(testState.dir).list()[0]
      const pid = saved.model.modelData.match(/BEFORE:(\d+):retained/)![1]
      source.dispose()
      source = undefined
      mux.dispose()
      await expect(
        recoverSelectedOutgoingOrcadCapture(testState.dir, {
          selector: 'destination',
          bridgeId: saved.identity.bridgeId,
          signal: new AbortController().signal
        })
      ).resolves.toEqual({ bridgeId: saved.identity.bridgeId, outcome: 'published' })
      const findTerminal = async () => {
        const result = (await destination.rpc('terminal.list', {
          requireFreshPtyLiveness: true,
          includeVisualLayouts: false
        })) as {
          terminals: {
            handle: string
            ptyId: string
            incarnationId: string
            connected: boolean
            writable: boolean
          }[]
        }
        const terminal = result.terminals.find((item) => item.ptyId === saved.identity.terminalId)
        expect(terminal, destination.diagnostics()).toMatchObject({
          incarnationId: saved.identity.incarnationId,
          connected: true,
          writable: true
        })
        return terminal!
      }
      const read = async (handle: string) => {
        const result = (await destination.rpc('terminal.read', {
          terminal: handle,
          screen: true,
          limit: 1000
        })) as { terminal: { tail: string[] } }
        return result.terminal.tail.map((line) => line.trim())
      }
      let handle = ''
      await vi.waitFor(
        async () => {
          handle = (await findTerminal()).handle
        },
        { timeout: 15_000 }
      )
      expect(await read(handle)).toContain(`BEFORE:${pid}:retained`)
      expect(handle).toBe(sourceTerminalHandle)
      console.info('Captured terminal verified through public RPC; restarting destination')
      await destination.stop('SIGKILL')
      let worker: Awaited<ReturnType<typeof seedLiveOrcadRestoredWorker>> | undefined
      if (sourceAtRestart === 'unavailable') {
        worker = await seedLiveOrcadRestoredWorker({
          directory: destinationDirectory,
          runtimeId: serving.runtimeId,
          handle,
          workspaceKey,
          tabId: surfaceBinding.tabId,
          leafId: surfaceBinding.leafId,
          terminalId: saved.identity.terminalId,
          incarnationId: saved.identity.incarnationId
        })
        renameSync(daemon.endpoint, hiddenEndpoint)
        endpointHidden = true
      }
      const restarted = await destination.start()
      expect(destination.startupDurationMs()).toBeLessThan(30_000)
      expect(restarted.runtimeId).toBe(serving.runtimeId)
      if (endpointHidden) {
        expect(
          await destination.rpc('orchestration.workerShow', { dispatch: worker!.dispatchId })
        ).toMatchObject({
          worker: { state: 'ready' },
          observation: {
            status: 'unverifiable',
            exactWorker: false,
            reason: 'delegated_terminal_observation_unavailable'
          }
        })
        expect(readLiveOrcadSleepingWorker(destinationDirectory, worker!.paneKey)).toMatchObject({
          automaticResumeBlockedBy: 'legacy-orchestration-worker'
        })
        await expect(destination.rpc('projectGroup.list', {})).resolves.toBeDefined()
        await expect(
          destination.rpc('terminal.send', {
            terminal: handle,
            text: 'printf "UNVERIFIABLE_WRITE_MUST_NOT_RUN\\n"',
            enter: true
          })
        ).rejects.toThrow()
        renameSync(hiddenEndpoint, daemon.endpoint)
        endpointHidden = false
      }
      await vi.waitFor(
        async () => {
          handle = (await findTerminal()).handle
        },
        { timeout: 45_000 }
      )
      expect(await read(handle)).toContain(`BEFORE:${pid}:retained`)
      if (worker) {
        await vi.waitFor(
          async () => {
            expect(
              await destination.rpc('orchestration.workerShow', { dispatch: worker!.dispatchId })
            ).toMatchObject({
              worker: { state: 'ready' },
              observation: { status: 'live', exactWorker: true }
            })
            expect(
              readLiveOrcadSleepingWorker(destinationDirectory, worker!.paneKey)
            ).toBeUndefined()
          },
          { timeout: 15_000 }
        )
      }
      const sent = (await destination.rpc('terminal.send', {
        terminal: handle,
        text: 'printf "\\nAFTER:%s:%s\\n" "$$" "$ORCA_RESTART_VALUE"',
        enter: true
      })) as { send: { accepted: boolean } }
      expect(sent.send.accepted).toBe(true)
      await vi.waitFor(
        async () => {
          const lines = await read(handle)
          expect(lines.filter((line) => line === `BEFORE:${pid}:retained`)).toHaveLength(1)
          expect(lines.filter((line) => line === `AFTER:${pid}:retained`)).toHaveLength(1)
          expect(lines.join('\n')).not.toContain('UNVERIFIABLE_WRITE_MUST_NOT_RUN')
        },
        { timeout: 15_000 }
      )
      expect(new OrcadOutgoingCaptureStore(testState.dir).read(saved.identity)).toEqual(saved)
      // The destination owns this test terminal; source shutdown must not bypass transfer fences.
      await destination.rpc('terminal.close', { terminal: handle })
    } finally {
      if (endpointHidden) {
        renameSync(hiddenEndpoint, daemon.endpoint)
      }
      await destination.stop()
      source?.dispose()
      mux?.dispose()
      setSshTargetRegistryStore(previousTargets)
      vi.unstubAllEnvs()
      await daemon.dispose()
    }
  },
  420_000
)
