import { describe, expect, it, vi } from 'vitest'
import { createHudStore, type HudState, type HudStore } from '../state/hud-store'
import type { RpcPort, RpcResponse } from '../transport/orca-rpc-wire'
import type { ActiveHostSession, HostSessionManager } from './host-session-manager'
import { createNavPorts, type NavPortsDeps, type NavPortsTimer } from './nav-ports'

function initialState(overrides: Partial<HudState> = {}): HudState {
  return {
    connection: { hostId: 'host-a', state: 'connected', compat: null },
    hosts: [],
    // wt-1 defaults to `permission` so sendAskAnswer's re-validation (CRITICAL #11) passes and
    // tests reach the resolution/send logic; override per-test to exercise the guard itself.
    dashboard: {
      rows: [{ worktreeId: 'wt-1', displayName: 'wt-1', status: 'permission' }],
      fetchedAt: 0,
      stale: false
    },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askInteraction: null,
    nav: {
      stack: [{ screen: 'dashboard', hostId: 'host-a', cursor: 0, page: 0 }],
      exitDialogArmed: false
    },
    ...overrides
  }
}

function okResponse(result: unknown): RpcResponse {
  return { id: '1', ok: true, result, _meta: { runtimeId: 'r' } }
}

function failResponse(): RpcResponse {
  return { id: '1', ok: false, error: { code: 'boom', message: 'boom' }, _meta: { runtimeId: 'r' } }
}

type FakeSessionOptions = {
  hostId?: string
  resolveActiveResult?: RpcResponse
  listResult?: RpcResponse
  /** Handles terminal.list reports for the worktree; default a single 'term-1'. */
  terminals?: string[]
  /** Which of `terminals` report an agentStatus.state of 'waiting' (needs input). */
  waitingHandles?: string[]
  sendResult?: RpcResponse
  /** Throws instead of resolving, per method — models a transport failure (HIGH #2/#3). */
  throwOn?: 'terminal.list' | 'terminal.send'
}

function fakeSession(opts: FakeSessionOptions = {}): {
  session: ActiveHostSession
  sendRequest: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  refreshNow: ReturnType<typeof vi.fn>
} {
  const terminals = opts.terminals ?? ['term-1']
  const waitingHandles = opts.waitingHandles ?? ['term-1']
  const sendRequest = vi.fn(async (method: string, params?: unknown): Promise<RpcResponse> => {
    if (method === 'terminal.resolveActive') {
      return opts.resolveActiveResult ?? okResponse({ handle: 'term-1' })
    }
    if (method === 'terminal.list') {
      if (opts.throwOn === 'terminal.list') {
        throw new Error('socket closed mid-request')
      }
      return opts.listResult ?? okResponse({ terminals: terminals.map((handle) => ({ handle })) })
    }
    if (method === 'terminal.agentStatus') {
      const handle = (params as { terminal: string }).terminal
      const state = waitingHandles.includes(handle) ? 'waiting' : 'working'
      return okResponse({ agentStatus: { state } })
    }
    if (opts.throwOn === 'terminal.send') {
      throw new Error('socket closed mid-request')
    }
    return opts.sendResult ?? okResponse({ send: { accepted: true, bytesWritten: 2 } })
  })
  const client: RpcPort = { sendRequest, subscribe: vi.fn() }
  const open = vi.fn()
  const close = vi.fn()
  const refreshNow = vi.fn()
  const session: ActiveHostSession = {
    hostId: opts.hostId ?? 'host-a',
    client: client as unknown as ActiveHostSession['client'],
    dashboard: { refreshNow } as unknown as ActiveHostSession['dashboard'],
    terminalTail: { open, close } as unknown as ActiveHostSession['terminalTail'],
    stop: vi.fn()
  }
  return { session, sendRequest, open, close, refreshNow }
}

function fakeSessions(session: ActiveHostSession | null): HostSessionManager {
  return {
    current: () => session,
    connect: vi.fn(async () => {}),
    close: vi.fn()
  } as unknown as HostSessionManager
}

/** Deterministic stand-in for the real timer (finding #12's bounded confirmation poll) — queues
 *  callbacks instead of scheduling them, so tests drive the poll with `runAll()` rather than
 *  waiting on real time. */
function fakeTimer(): { timer: NavPortsTimer; runAll: () => void } {
  const pending: (() => void)[] = []
  return {
    timer: {
      setTimeout: (cb) => {
        pending.push(cb)
        return pending.length
      },
      clearTimeout: () => {}
    },
    runAll: () => {
      while (pending.length > 0) {
        pending.shift()!()
      }
    }
  }
}

function makeDeps(
  store: HudStore,
  sessions: HostSessionManager,
  timer?: NavPortsTimer
): NavPortsDeps {
  return {
    bridge: {} as NavPortsDeps['bridge'],
    store,
    sessions,
    renderQueue: { invalidate: vi.fn() } as unknown as NavPortsDeps['renderQueue'],
    submitRender: vi.fn(),
    setForeground: vi.fn(),
    timer
  }
}

// sendAskAnswer's new resolution chain (terminal.list -> parallel terminal.agentStatus probes ->
// terminal.send) is several microtask hops deeper than the old single-RPC resolveActive path;
// loop generously rather than guess an exact tick count.
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

describe('sendAskAnswer', () => {
  it('drops the effect when the session hostId does not match the effect hostId', async () => {
    const { session, sendRequest } = fakeSession({ hostId: 'host-b' })
    const store = createHudStore(initialState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()

    expect(sendRequest).not.toHaveBeenCalled()
    expect(store.getState().askInteraction).toBeNull()
  })

  it('CRITICAL #11: fails closed without any RPC call when the worktree is no longer in permission', async () => {
    const { session, sendRequest } = fakeSession()
    const store = createHudStore(
      initialState({
        dashboard: {
          rows: [{ worktreeId: 'wt-1', displayName: 'wt-1', status: 'working' }],
          fetchedAt: 5,
          stale: false
        }
      })
    )
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()

    expect(sendRequest).not.toHaveBeenCalled()
    expect(store.getState().askInteraction).toMatchObject({ worktreeId: 'wt-1', phase: 'failed' })
  })

  it('CRITICAL #10: fails closed (never guesses) when no terminal is waiting', async () => {
    const { session, sendRequest } = fakeSession({ terminals: [] })
    const store = createHudStore(initialState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()

    expect(sendRequest).toHaveBeenCalledTimes(1) // terminal.list only, never terminal.send
    expect(store.getState().askInteraction).toMatchObject({ phase: 'failed' })
  })

  it('CRITICAL #10: fails closed (never guesses) when more than one terminal is waiting', async () => {
    const { session, sendRequest } = fakeSession({
      terminals: ['term-1', 'term-2'],
      waitingHandles: ['term-1', 'term-2']
    })
    const store = createHudStore(initialState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()

    // terminal.list + 2x terminal.agentStatus, never terminal.send
    expect(sendRequest).toHaveBeenCalledTimes(3)
    expect(sendRequest).not.toHaveBeenCalledWith('terminal.send', expect.anything())
    expect(store.getState().askInteraction).toMatchObject({ phase: 'failed' })
  })

  it('fails closed when terminal.list itself reports failure', async () => {
    const { session } = fakeSession({ listResult: failResponse() })
    const store = createHudStore(initialState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()

    expect(store.getState().askInteraction).toMatchObject({ phase: 'failed' })
  })

  it('HIGH #2/#3: sets phase unresolved (never silently swallowed) when terminal.list throws', async () => {
    const { session } = fakeSession({ throwOn: 'terminal.list' })
    const store = createHudStore(initialState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()

    expect(store.getState().askInteraction).toMatchObject({ phase: 'unresolved' })
  })

  it('HIGH #2/#3: sets phase unresolved when terminal.send throws', async () => {
    const { session } = fakeSession({ throwOn: 'terminal.send' })
    const store = createHudStore(initialState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()

    expect(store.getState().askInteraction).toMatchObject({ phase: 'unresolved' })
  })

  it('sets phase failed when terminal.send responds ok but not accepted', async () => {
    const { session } = fakeSession({
      sendResult: okResponse({ send: { accepted: false, bytesWritten: 0 } })
    })
    const store = createHudStore(initialState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()

    expect(store.getState().askInteraction).toMatchObject({ phase: 'failed' })
  })

  it('sets phase failed when terminal.send fails at the RPC level', async () => {
    const { session } = fakeSession({ sendResult: failResponse() })
    const store = createHudStore(initialState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()

    expect(store.getState().askInteraction).toMatchObject({ phase: 'failed' })
  })

  it('CRITICAL #11: an accepted send enters checking, not an immediate optimistic answered', async () => {
    const { session } = fakeSession()
    const store = createHudStore(initialState())
    const { timer } = fakeTimer()
    const ports = createNavPorts(makeDeps(store, fakeSessions(session), timer))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()

    expect(store.getState().askInteraction).toMatchObject({ worktreeId: 'wt-1', phase: 'checking' })
  })

  it('HIGH #12: confirms answered once a bounded refresh observes the worktree left permission', async () => {
    const { session, refreshNow } = fakeSession()
    const store = createHudStore(initialState())
    refreshNow.mockImplementation(() => {
      store.update((s) => ({
        ...s,
        dashboard: {
          rows: [{ worktreeId: 'wt-1', displayName: 'wt-1', status: 'working' }],
          fetchedAt: 10,
          stale: false
        }
      }))
    })
    const { timer, runAll } = fakeTimer()
    const ports = createNavPorts(makeDeps(store, fakeSessions(session), timer))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()
    runAll()

    expect(store.getState().askInteraction).toMatchObject({ phase: 'answered' })
  })

  it('HIGH #12: sets unresolved (honest, not optimistic) once bounded attempts exhaust while still permission', async () => {
    const { session, refreshNow } = fakeSession() // never changes dashboard status
    const store = createHudStore(initialState())
    const { timer, runAll } = fakeTimer()
    const ports = createNavPorts(makeDeps(store, fakeSessions(session), timer))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()
    runAll()

    expect(refreshNow).toHaveBeenCalled()
    expect(store.getState().askInteraction).toMatchObject({ phase: 'unresolved' })
  })

  it('CRITICAL #11: ignores a rapid second click while the first send is still in flight', async () => {
    const { session, sendRequest } = fakeSession()
    const store = createHudStore(initialState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    ports.sendAskAnswer('host-a', 'wt-1', '1\r') // rapid double click
    await flush()

    // terminal.list + terminal.agentStatus + terminal.send = 3 calls total, not 6.
    expect(sendRequest).toHaveBeenCalledTimes(3)
  })
})

describe('openTerminalTail', () => {
  function tailFrameState(): HudState {
    return initialState({
      nav: {
        stack: [
          { screen: 'terminalTail', hostId: 'host-a', worktreeId: 'wt-1', terminalId: '', page: 0 }
        ],
        exitDialogArmed: false
      }
    })
  }

  it('resolves the active terminal, opens the tail, and patches the frame id', async () => {
    const { session, open } = fakeSession()
    const store = createHudStore(tailFrameState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.openTerminalTail('wt-1')
    await flush()

    expect(open).toHaveBeenCalledWith('term-1')
    const frame = store.getState().nav.stack[0]
    expect(frame).toMatchObject({ screen: 'terminalTail', terminalId: 'term-1' })
  })

  it('does not subscribe when the active session changed while resolving (finding #8)', async () => {
    const { session, open } = fakeSession()
    const store = createHudStore(tailFrameState())
    let current: ActiveHostSession | null = session
    const sessions = {
      current: () => current,
      connect: vi.fn(),
      close: vi.fn()
    } as unknown as HostSessionManager
    const ports = createNavPorts(makeDeps(store, sessions))

    ports.openTerminalTail('wt-1')
    // Host switched before resolveActive's promise settles.
    current = fakeSession({ hostId: 'host-b' }).session
    await flush()

    expect(open).not.toHaveBeenCalled()
  })

  it('does not subscribe when the user navigated off the terminal-tail frame (finding #8)', async () => {
    const { session, open } = fakeSession()
    const store = createHudStore(tailFrameState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.openTerminalTail('wt-1')
    // User backs out to the dashboard before resolution completes.
    store.update((s) => ({
      ...s,
      nav: {
        stack: [{ screen: 'dashboard', hostId: 'host-a', cursor: 0, page: 0 }],
        exitDialogArmed: false
      }
    }))
    await flush()

    expect(open).not.toHaveBeenCalled()
  })

  it('does not subscribe when closeTerminalTail runs before resolution completes (finding #8)', async () => {
    const { session, open, close } = fakeSession()
    const store = createHudStore(tailFrameState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.openTerminalTail('wt-1')
    ports.closeTerminalTail('term-1')
    await flush()

    expect(open).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1) // only the explicit close, not a stale re-open
  })
})
