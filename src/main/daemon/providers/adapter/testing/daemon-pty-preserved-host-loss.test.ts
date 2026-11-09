// #38432: after an update keeps the previous version's terminal host, that host dying left its
// panes "connected" on a frozen frame. Simulates the upgrade with live sessions on both hosts.
import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import { DaemonPtyRouter } from '../../routing/daemon-pty-router'
import { DaemonServer } from '../../../server/daemon-server'
import { PROTOCOL_VERSION } from '../../../protocol/daemon-protocol-version'
import { getDaemonSocketPath } from '../../../launch/daemon-spawner'
import type { DaemonFileLog } from '../../../observability/daemon-file-log'
import type { DaemonPtyRouterExitEvent } from '../../../protocol/daemon-pty-router-events'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'

const LEGACY_PROTOCOL = PROTOCOL_VERSION - 1

type ClientInternals = {
  handleDisconnect: (generation: number) => void
  connectionGeneration: number
  isConnected: () => boolean
}

function adapterClient(adapter: DaemonPtyAdapter): ClientInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the adapter's own DaemonClient to drop only its transport, as a broken pipe would.
  const internals = adapter as unknown as { client: ClientInternals }
  return internals.client
}

describe('a preserved older-version terminal host that dies', () => {
  const servers: DaemonServer[] = []
  const adapters: DaemonPtyAdapter[] = []
  const directories: string[] = []
  let router: DaemonPtyRouter | null = null

  afterEach(async () => {
    router?.dispose()
    router = null
    for (const adapter of adapters.splice(0)) {
      adapter.dispose()
    }
    await Promise.all(servers.splice(0).map((server) => server.shutdown().catch(() => {})))
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  async function upgradeWithLiveSessions() {
    const directory = mkdtempSync(join(tmpdir(), 'daemon-preserved-host-loss-'))
    directories.push(directory)
    const log: DaemonFileLog = { log: () => {}, close: () => {} }
    const legacySocketPath = getDaemonSocketPath(directory, LEGACY_PROTOCOL)
    const currentSocketPath = getDaemonSocketPath(directory, PROTOCOL_VERSION)
    const legacyTokenPath = join(directory, 'legacy.token')
    const currentTokenPath = join(directory, 'current.token')
    const legacySubprocesses: ReturnType<typeof createMockSubprocess>[] = []
    const currentSubprocesses: ReturnType<typeof createMockSubprocess>[] = []
    const legacyServer = new DaemonServer({
      socketPath: legacySocketPath,
      tokenPath: legacyTokenPath,
      protocolVersion: LEGACY_PROTOCOL,
      log,
      spawnSubprocess: () => {
        const subprocess = createMockSubprocess()
        legacySubprocesses.push(subprocess)
        return subprocess
      }
    })
    const currentServer = new DaemonServer({
      socketPath: currentSocketPath,
      tokenPath: currentTokenPath,
      protocolVersion: PROTOCOL_VERSION,
      log,
      spawnSubprocess: () => {
        const subprocess = createMockSubprocess()
        currentSubprocesses.push(subprocess)
        return subprocess
      }
    })
    servers.push(legacyServer, currentServer)
    await Promise.all([legacyServer.start(), currentServer.start()])

    // The previous app version starts two agent panes on its own host, then quits to update.
    const oldApp = new DaemonPtyAdapter({
      socketPath: legacySocketPath,
      tokenPath: legacyTokenPath,
      protocolVersion: LEGACY_PROTOCOL
    })
    adapters.push(oldApp)
    const first = await oldApp.spawn({ sessionId: 'agent-1', cols: 80, rows: 24 })
    const second = await oldApp.spawn({ sessionId: 'agent-2', cols: 80, rows: 24 })
    oldApp.dispose()

    // The updated app keeps the old host (no respawn) and starts its own.
    const legacy = new DaemonPtyAdapter({
      socketPath: legacySocketPath,
      tokenPath: legacyTokenPath,
      protocolVersion: LEGACY_PROTOCOL,
      runtimeDir: directory,
      preservedEndpointLossProbeDelaysMs: [5],
      // The fixture host shares this test's pid, so its exit is stubbed as proven.
      preservedDaemonExited: () => true
    })
    const current = new DaemonPtyAdapter({
      socketPath: currentSocketPath,
      tokenPath: currentTokenPath,
      protocolVersion: PROTOCOL_VERSION,
      runtimeDir: directory
    })
    adapters.push(legacy, current)
    router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()
    const exits: DaemonPtyRouterExitEvent[] = []
    router.onExit((payload) => exits.push(payload))
    for (const session of [first, second]) {
      await router.spawn({ sessionId: session.id, cols: 80, rows: 24, attachOnly: true })
    }
    const fresh = await router.spawn({ sessionId: 'new-pane', cols: 80, rows: 24 })
    return {
      router,
      legacy,
      legacyServer,
      legacySubprocesses,
      currentSubprocesses,
      exits,
      first,
      second,
      fresh
    }
  }

  it('ends each of its PTYs as host loss, and the panes restore on the current host', async () => {
    const run = await upgradeWithLiveSessions()
    expect(run.legacySubprocesses).toHaveLength(2)
    expect(run.currentSubprocesses).toHaveLength(1)

    // The old host dies: its socket stays behind but nothing listens.
    await run.legacyServer.shutdown()

    await vi.waitFor(() => expect(run.exits).toHaveLength(2), { timeout: 3_000 })
    expect(run.exits).toEqual(
      expect.arrayContaining([
        { id: run.first.id, code: -1, incarnationId: run.first.incarnationId, hostLost: true },
        { id: run.second.id, code: -1, incarnationId: run.second.incarnationId, hostLost: true }
      ])
    )
    // The current host's pane is untouched.
    expect(run.exits.some((exit) => exit.id === run.fresh.id)).toBe(false)
    expect(run.router.hasPty(run.fresh.id)).toBe(true)

    // Restoring the pane must not be refused because the dead host cannot answer.
    const restored = await run.router.spawn({ sessionId: run.first.id, cols: 80, rows: 24 })
    expect(restored.id).toBe(run.first.id)
    expect(run.currentSubprocesses).toHaveLength(2)
  })

  it('keeps the panes when the host answers again before the loss is proven', async () => {
    const run = await upgradeWithLiveSessions()
    // Drop only the connection; the host and its PTYs keep running.
    const client = adapterClient(run.legacy)
    client.handleDisconnect(client.connectionGeneration)
    expect(client.isConnected()).toBe(false)

    // The first probe reconnects, which settles the check without a verdict of loss.
    await vi.waitFor(() => expect(client.isConnected()).toBe(true))
    expect(run.exits).toEqual([])
    expect(run.router.hasPty(run.first.id)).toBe(true)
    expect(run.router.hasPty(run.second.id)).toBe(true)
  })
})
