import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  event: (_value: unknown) => {},
  disconnected: () => {},
  connect: vi.fn(),
  request: vi.fn(),
  disconnect: vi.fn(),
  notify: vi.fn(),
  removeEvent: vi.fn(),
  removeDisconnect: vi.fn()
}))
vi.mock('../daemon/daemon-provider-state', () => ({
  getDaemonEndpointFacts: () => ({ socketPath: '/fixture/socket', tokenPath: '/fixture/token' })
}))
vi.mock('../daemon/client', () => ({
  DaemonClient: class {
    ensureConnected = state.connect
    request = state.request
    disconnect = state.disconnect
    notify = state.notify
    onEvent(callback: typeof state.event) {
      state.event = callback
      return state.removeEvent
    }
    onDisconnected(callback: () => void) {
      state.disconnected = callback
      return state.removeDisconnect
    }
  }
}))
import { spawnHiddenDaemonPty } from './hidden-daemon-pty'
const options = {
  cwd: '/fixture',
  cols: 120,
  rows: 40,
  env: { TOKEN: 'fixture', REMOVED: undefined }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.notify.mockReturnValue(true)
  state.connect.mockResolvedValue(undefined)
  state.request.mockImplementation(async (type) =>
    type === 'ping' ? { pong: true, capabilities: { transientPty: 1 } } : { pid: 123 }
  )
})

describe('hidden daemon PTY client', () => {
  it('refuses an old daemon without spawning or replacing it', async () => {
    state.request.mockResolvedValue({ pong: true })
    await expect(spawnHiddenDaemonPty('/tool', [], options)).rejects.toThrow('does not support')
    expect(state.request).toHaveBeenCalledTimes(1)
    expect(state.disconnect).toHaveBeenCalledOnce()
  })

  it('preserves exact arguments and strips absent environment values', async () => {
    const term = await spawnHiddenDaemonPty('/tool', ['a b', '$literal'], options)
    expect(state.request.mock.calls[1][1]).toMatchObject({
      file: '/tool',
      args: ['a b', '$literal'],
      env: { TOKEN: 'fixture' },
      cwd: '/fixture'
    })
    expect(state.request.mock.calls[1][1].env).not.toHaveProperty('REMOVED')
    term.kill()
    expect(state.removeEvent).toHaveBeenCalledOnce()
    expect(state.removeDisconnect).toHaveBeenCalledOnce()
  })

  it('buffers output and exit arriving before the create reply', async () => {
    state.request.mockImplementation(async (type, payload) => {
      if (type === 'ping') {
        return { capabilities: { transientPty: 1 } }
      }
      state.event({
        type: 'event',
        event: 'data',
        sessionId: payload.id,
        payload: { data: 'first' }
      })
      state.event({ type: 'event', event: 'exit', sessionId: payload.id, payload: { code: 0 } })
      return { pid: 123 }
    })
    const term = await spawnHiddenDaemonPty('/tool', [], options)
    const events: unknown[] = []
    term.onData((data) => events.push(data))
    term.onExit((event) => events.push(event))
    await Promise.resolve()
    expect(events).toEqual(['first', { exitCode: 0 }])
    term.destroy()
  })

  it('closes a connection that completes after abort', async () => {
    let connected: () => void = () => {}
    state.connect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          connected = resolve
        })
    )
    const controller = new AbortController()
    const creation = spawnHiddenDaemonPty('/tool', [], options, controller.signal)
    controller.abort()
    connected()
    await expect(creation).rejects.toThrow()
    expect(state.request).not.toHaveBeenCalled()
    expect(state.disconnect).toHaveBeenCalledTimes(2)
  })
  it.each(['disconnect', 'terminalError', 'overflow'])(
    'reports %s as failure, never process exit',
    async (failure) => {
      const term = await spawnHiddenDaemonPty('/tool', [], options)
      const onError = vi.fn()
      const onExit = vi.fn()
      term.onError(onError)
      term.onExit(onExit)
      const id = state.request.mock.calls[1][1].id
      if (failure === 'disconnect') {
        state.disconnected()
      } else {
        state.event({
          type: 'event',
          event: failure === 'overflow' ? 'data' : 'terminalError',
          sessionId: id,
          payload: failure === 'overflow' ? { data: 'x'.repeat(128 * 1024 + 1) } : {}
        })
      }
      await Promise.resolve()
      expect(onError).toHaveBeenCalledOnce()
      expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
      expect(onExit).not.toHaveBeenCalled()
      expect(state.removeEvent).toHaveBeenCalledOnce()
      expect(state.removeDisconnect).toHaveBeenCalledOnce()
    }
  )

  it('keeps a confirmed exit when transport closes and delivers it only once', async () => {
    const term = await spawnHiddenDaemonPty('/tool', [], options)
    const onExit = vi.fn()
    const onError = vi.fn()
    term.onExit(onExit)
    term.onError(onError)
    const id = state.request.mock.calls[1][1].id
    state.event({ type: 'event', event: 'exit', sessionId: id, payload: { code: 7 } })
    state.disconnected()
    await Promise.resolve()
    term.onData(vi.fn())
    await Promise.resolve()
    expect(onExit).toHaveBeenCalledExactlyOnceWith({ exitCode: 7 })
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a failed input delivery once without claiming process exit', async () => {
    const term = await spawnHiddenDaemonPty('/tool', [], options)
    const onError = vi.fn()
    const onExit = vi.fn()
    term.onError(onError)
    term.onExit(onExit)
    state.notify.mockReturnValue(false)
    term.write('/status')
    term.write('\r')
    state.disconnected()
    await Promise.resolve()
    expect(state.notify).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      new Error('Terminal service could not receive usage probe input')
    )
    expect(onExit).not.toHaveBeenCalled()
  })

  it('rejects a create receipt arriving after transport failure and removes listeners', async () => {
    state.request.mockImplementation(async (type) => {
      if (type === 'ping') {
        return { capabilities: { transientPty: 1 } }
      }
      state.disconnected()
      return { pid: 123 }
    })
    await expect(spawnHiddenDaemonPty('/tool', [], options)).rejects.toThrow('connection lost')
    expect(state.removeEvent).toHaveBeenCalledOnce()
    expect(state.removeDisconnect).toHaveBeenCalledOnce()
  })

  it('retains a failure until listeners attach and ignores late exit evidence', async () => {
    const term = await spawnHiddenDaemonPty('/tool', [], options)
    state.disconnected()
    await Promise.resolve()
    const onError = vi.fn()
    const onExit = vi.fn()
    term.onError(onError)
    term.onExit(onExit)
    const id = state.request.mock.calls[1][1].id
    state.event({ type: 'event', event: 'exit', sessionId: id, payload: { code: 0 } })
    await Promise.resolve()
    expect(onError).toHaveBeenCalledOnce()
    expect(onExit).not.toHaveBeenCalled()
    expect(state.removeEvent).toHaveBeenCalledOnce()
  })
})
