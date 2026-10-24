// Exercises HostSessionManager against a real OrcaSocketClient over an in-memory socket pair
// (via OrcaHandshakeTestServer) so the compat-gate/host-switch fixes (findings #2/#4) are
// exercised through an actual handshake instead of a hand-rolled RpcPort stub.
import { beforeEach, describe, expect, it } from 'vitest'
import { createHudStore, type HudState, type HudStore } from '../state/hud-store'
import { createMemorySocketPair } from '../sim/memory-socket-pair'
import { toWebSocketLike } from '../sim/memory-socket-web-socket-adapter'
import type { WebSocketLike } from '../transport/orca-socket-client'
import { HostSessionManager } from './host-session-manager'
import { OrcaHandshakeTestServer } from './orca-handshake-test-server'

const DEVICE_TOKEN = 'device-token'

function initialState(overrides: Partial<HudState> = {}): HudState {
  return {
    connection: { hostId: null, state: 'disconnected', compat: null },
    hosts: [],
    dashboard: { rows: [], fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askInteraction: null,
    // Dashboard visible (matching WorktreeDashboardController's isVisible predicate) so
    // dashboard.start()'s immediate tick actually polls once feature controllers start.
    nav: {
      stack: [{ screen: 'dashboard', hostId: 'host-a', cursor: 0, page: 0 }],
      exitDialogArmed: false
    },
    ...overrides
  }
}

async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('HostSessionManager', () => {
  let store: HudStore

  beforeEach(() => {
    store = createHudStore(initialState())
  })

  function connectAgainstServer(
    server: OrcaHandshakeTestServer,
    hostId = 'host-a'
  ): { manager: HostSessionManager; connectPromise: Promise<void> } {
    const socketFactory = (_url: string): WebSocketLike => {
      const { clientSocket, serverSocket } = createMemorySocketPair()
      server.attach(serverSocket)
      return toWebSocketLike(clientSocket)
    }
    const profile = {
      id: hostId,
      name: hostId,
      endpoint: 'memory://test',
      deviceToken: DEVICE_TOKEN,
      publicKeyB64: server.publicKeyB64,
      lastConnected: 0
    }
    const manager = new HostSessionManager({
      store,
      hostProfileStore: {
        load: async () => [profile],
        upsert: async () => {},
        remove: async () => {}
      },
      isForeground: () => true,
      socketFactory
    })
    return { manager, connectPromise: manager.connect(hostId) }
  }

  it('starts dashboard/notification polling once a compatible verdict resolves', async () => {
    const server = new OrcaHandshakeTestServer({
      deviceToken: DEVICE_TOKEN,
      protocolVersion: 3,
      minCompatibleMobileVersion: 2
    })
    const { connectPromise } = connectAgainstServer(server)
    await connectPromise
    await flushMicrotasks()

    expect(store.getState().connection.compat).toEqual({ kind: 'ok' })
    expect(server.calledMethods).toContain('worktree.ps')
    expect(server.calledMethods).toContain('notifications.subscribe')
  })

  it('never starts dashboard/notification polling on a blocked compat verdict (finding #4)', async () => {
    // Desktop reports a protocol version below this client's MIN_COMPATIBLE_DESKTOP_VERSION (2).
    const server = new OrcaHandshakeTestServer({
      deviceToken: DEVICE_TOKEN,
      protocolVersion: 1,
      minCompatibleMobileVersion: 0
    })
    const { connectPromise } = connectAgainstServer(server)
    await connectPromise
    await flushMicrotasks()

    expect(store.getState().connection.compat).toMatchObject({ kind: 'blocked' })
    expect(server.calledMethods).not.toContain('worktree.ps')
    expect(server.calledMethods).not.toContain('notifications.subscribe')
  })

  it('clears dashboard/inbox/terminalTail slices as soon as connect() targets a new host (finding #2)', async () => {
    store.update((s) => ({
      ...s,
      dashboard: {
        rows: [{ worktreeId: 'stale-wt', displayName: 'stale' }],
        fetchedAt: 1,
        stale: false
      },
      inbox: {
        entries: [
          {
            notificationId: 'n1',
            title: 't',
            body: 'b',
            worktreeId: 'stale-wt',
            receivedAt: 1,
            kind: 'ask'
          }
        ]
      },
      terminalTail: { terminalId: 'stale-term', lines: ['x'], live: true }
    }))

    const server = new OrcaHandshakeTestServer({
      deviceToken: DEVICE_TOKEN,
      protocolVersion: 3,
      minCompatibleMobileVersion: 2
    })
    const { connectPromise } = connectAgainstServer(server)
    // Slices are cleared by the very first store.update inside connect(), before the compat
    // handshake even starts — check well before the full connect() (which awaits compat).
    await flushMicrotasks(2)

    expect(store.getState().dashboard.rows).toEqual([])
    expect(store.getState().inbox.entries).toEqual([])
    expect(store.getState().terminalTail).toEqual({ terminalId: null, lines: [], live: false })

    await connectPromise
  })

  it('close() resets connection/dashboard/inbox slices, not just terminalTail (finding #3)', async () => {
    const server = new OrcaHandshakeTestServer({
      deviceToken: DEVICE_TOKEN,
      protocolVersion: 3,
      minCompatibleMobileVersion: 2
    })
    const { manager, connectPromise } = connectAgainstServer(server)
    await connectPromise
    await flushMicrotasks()

    expect(store.getState().connection.hostId).toBe('host-a')
    // Fabricate leftover host-scoped state close() must also clear (dashboard/inbox aren't
    // touched by ActiveHostSession.stop() at all).
    store.update((s) => ({
      ...s,
      dashboard: {
        rows: [{ worktreeId: 'wt-1', displayName: 'wt-1' }],
        fetchedAt: 1,
        stale: false
      },
      inbox: {
        entries: [
          {
            notificationId: 'n1',
            title: 't',
            body: 'b',
            worktreeId: 'wt-1',
            receivedAt: 1,
            kind: 'ask'
          }
        ]
      }
    }))

    manager.close()

    expect(store.getState().connection).toEqual({
      hostId: null,
      state: 'disconnected',
      compat: null
    })
    expect(store.getState().dashboard).toEqual({ rows: [], fetchedAt: 0, stale: false })
    expect(store.getState().inbox).toEqual({ entries: [] })
    expect(store.getState().terminalTail).toEqual({ terminalId: null, lines: [], live: false })
  })
})
