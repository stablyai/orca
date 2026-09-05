import { describe, expect, it, vi } from 'vitest'
import { createHudStore, type HudState, type HudStore } from '../state/hud-store'
import type { RpcPort, RpcResponse } from '../transport/orca-rpc-wire'
import type { ActiveHostSession, HostSessionManager } from './host-session-manager'
import { createNavPorts, type NavPortsDeps } from './nav-ports'

function initialState(overrides: Partial<HudState> = {}): HudState {
  return {
    connection: { hostId: 'host-a', state: 'connected', compat: null },
    hosts: [],
    dashboard: { rows: [], fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askAnswered: null,
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
  sendResult?: RpcResponse
}

function fakeSession(opts: FakeSessionOptions = {}): {
  session: ActiveHostSession
  sendRequest: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'terminal.resolveActive') {
      return opts.resolveActiveResult ?? okResponse({ handle: 'term-1' })
    }
    return opts.sendResult ?? okResponse({ send: { accepted: true, bytesWritten: 2 } })
  })
  const client: RpcPort = { sendRequest, subscribe: vi.fn() }
  const open = vi.fn()
  const close = vi.fn()
  const session: ActiveHostSession = {
    hostId: opts.hostId ?? 'host-a',
    client: client as unknown as ActiveHostSession['client'],
    dashboard: { refreshNow: vi.fn() } as unknown as ActiveHostSession['dashboard'],
    terminalTail: { open, close } as unknown as ActiveHostSession['terminalTail'],
    stop: vi.fn()
  }
  return { session, sendRequest, open, close }
}

function fakeSessions(session: ActiveHostSession | null): HostSessionManager {
  return {
    current: () => session,
    connect: vi.fn(async () => {}),
    close: vi.fn()
  } as unknown as HostSessionManager
}

function makeDeps(store: HudStore, sessions: HostSessionManager): NavPortsDeps {
  return {
    bridge: {} as NavPortsDeps['bridge'],
    store,
    sessions,
    renderQueue: { invalidate: vi.fn() } as unknown as NavPortsDeps['renderQueue'],
    submitRender: vi.fn(),
    setForeground: vi.fn()
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('sendAskAnswer', () => {
  it('drops the effect when the session hostId does not match the effect hostId', async () => {
    const { session, sendRequest } = fakeSession({ hostId: 'host-b' })
    const store = createHudStore(initialState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()

    expect(sendRequest).not.toHaveBeenCalled()
    expect(store.getState().askAnswered).toBeNull()
  })

  it('fails closed and does not send when resolveActive returns no handle', async () => {
    const { session, sendRequest } = fakeSession({
      resolveActiveResult: okResponse({ handle: null })
    })
    const store = createHudStore(initialState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()

    expect(sendRequest).toHaveBeenCalledTimes(1) // only resolveActive, never terminal.send
    expect(store.getState().askAnswered).toBeNull()
  })

  it('fails closed when resolveActive itself fails', async () => {
    const { session, sendRequest } = fakeSession({ resolveActiveResult: failResponse() })
    const store = createHudStore(initialState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()

    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(store.getState().askAnswered).toBeNull()
  })

  it('marks the ask answered only when terminal.send is ok and accepted', async () => {
    const { session } = fakeSession()
    const store = createHudStore(initialState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()

    expect(store.getState().askAnswered).toEqual({
      worktreeId: 'wt-1',
      sentAt: expect.any(Number)
    })
  })

  it('does not mark answered when terminal.send fails at the RPC level', async () => {
    const { session } = fakeSession({ sendResult: failResponse() })
    const store = createHudStore(initialState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()

    expect(store.getState().askAnswered).toBeNull()
  })

  it('does not mark answered when terminal.send succeeds but accepted is false', async () => {
    const { session } = fakeSession({
      sendResult: okResponse({ send: { accepted: false, bytesWritten: 0 } })
    })
    const store = createHudStore(initialState())
    const ports = createNavPorts(makeDeps(store, fakeSessions(session)))

    ports.sendAskAnswer('host-a', 'wt-1', '1\r')
    await flush()

    expect(store.getState().askAnswered).toBeNull()
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
