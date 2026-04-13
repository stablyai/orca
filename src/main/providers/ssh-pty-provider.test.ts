import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'

type MockMultiplexer = {
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  onNotification: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  isDisposed: ReturnType<typeof vi.fn>
}

function createMockMux(): MockMultiplexer {
  return {
    request: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
}

describe('SshPtyProvider', () => {
  let mux: MockMultiplexer
  let provider: SshPtyProvider

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshPtyProvider('conn-1', mux as never)
  })

  it('returns the connectionId', () => {
    expect(provider.getConnectionId()).toBe('conn-1')
  })

  describe('spawn', () => {
    it('sends pty.spawn request through multiplexer', async () => {
      mux.request.mockResolvedValue({ id: 'pty-1' })

      const result = await provider.spawn({ cols: 80, rows: 24 })

      expect(mux.request).toHaveBeenCalledWith('pty.spawn', {
        cols: 80,
        rows: 24,
        cwd: undefined,
        env: undefined
      })
      expect(result).toEqual({ id: 'pty-1' })
    })

    it('passes cwd and env through', async () => {
      mux.request.mockResolvedValue({ id: 'pty-2' })

      await provider.spawn({
        cols: 120,
        rows: 40,
        cwd: '/home/user',
        env: { FOO: 'bar' }
      })

      expect(mux.request).toHaveBeenCalledWith('pty.spawn', {
        cols: 120,
        rows: 40,
        cwd: '/home/user',
        env: { FOO: 'bar' }
      })
    })
  })

  it('attach sends pty.attach request', async () => {
    await provider.attach('pty-1')
    expect(mux.request).toHaveBeenCalledWith('pty.attach', { id: 'pty-1' })
  })

  it('write sends pty.data notification', () => {
    provider.write('pty-1', 'hello')
    expect(mux.notify).toHaveBeenCalledWith('pty.data', { id: 'pty-1', data: 'hello' })
  })

  it('resize sends pty.resize notification', () => {
    provider.resize('pty-1', 120, 40)
    expect(mux.notify).toHaveBeenCalledWith('pty.resize', { id: 'pty-1', cols: 120, rows: 40 })
  })

  it('shutdown sends pty.shutdown request', async () => {
    await provider.shutdown('pty-1', true)
    expect(mux.request).toHaveBeenCalledWith('pty.shutdown', { id: 'pty-1', immediate: true })
  })

  it('sendSignal sends pty.sendSignal request', async () => {
    await provider.sendSignal('pty-1', 'SIGINT')
    expect(mux.request).toHaveBeenCalledWith('pty.sendSignal', { id: 'pty-1', signal: 'SIGINT' })
  })

  it('getCwd sends pty.getCwd request', async () => {
    mux.request.mockResolvedValue('/home/user/project')
    const cwd = await provider.getCwd('pty-1')
    expect(cwd).toBe('/home/user/project')
  })

  it('clearBuffer sends pty.clearBuffer request', async () => {
    await provider.clearBuffer('pty-1')
    expect(mux.request).toHaveBeenCalledWith('pty.clearBuffer', { id: 'pty-1' })
  })

  it('acknowledgeDataEvent sends pty.ackData notification', () => {
    provider.acknowledgeDataEvent('pty-1', 1024)
    expect(mux.notify).toHaveBeenCalledWith('pty.ackData', { id: 'pty-1', charCount: 1024 })
  })

  it('hasChildProcesses sends request and returns result', async () => {
    mux.request.mockResolvedValue(true)
    const result = await provider.hasChildProcesses('pty-1')
    expect(result).toBe(true)
  })

  it('getForegroundProcess returns process name', async () => {
    mux.request.mockResolvedValue('node')
    const result = await provider.getForegroundProcess('pty-1')
    expect(result).toBe('node')
  })

  it('listProcesses returns process list', async () => {
    const processes = [{ id: 'pty-1', cwd: '/home', title: 'zsh' }]
    mux.request.mockResolvedValue(processes)
    const result = await provider.listProcesses()
    expect(result).toEqual(processes)
  })

  it('getDefaultShell returns shell path', async () => {
    mux.request.mockResolvedValue('/bin/bash')
    const result = await provider.getDefaultShell()
    expect(result).toBe('/bin/bash')
  })

  describe('event listeners', () => {
    it('forwards pty.data notifications to data listeners', () => {
      const handler = vi.fn()
      provider.onData(handler)

      // Get the notification handler that was registered
      const notifHandler = mux.onNotification.mock.calls[0][0]
      notifHandler('pty.data', { id: 'pty-1', data: 'output' })

      expect(handler).toHaveBeenCalledWith({ id: 'pty-1', data: 'output' })
    })

    it('forwards pty.replay notifications to replay listeners', () => {
      const handler = vi.fn()
      provider.onReplay(handler)

      const notifHandler = mux.onNotification.mock.calls[0][0]
      notifHandler('pty.replay', { id: 'pty-1', data: 'buffered output' })

      expect(handler).toHaveBeenCalledWith({ id: 'pty-1', data: 'buffered output' })
    })

    it('forwards pty.exit notifications to exit listeners', () => {
      const handler = vi.fn()
      provider.onExit(handler)

      const notifHandler = mux.onNotification.mock.calls[0][0]
      notifHandler('pty.exit', { id: 'pty-1', code: 0 })

      expect(handler).toHaveBeenCalledWith({ id: 'pty-1', code: 0 })
    })

    it('allows unsubscribing from events', () => {
      const handler = vi.fn()
      const unsub = provider.onData(handler)
      unsub()

      const notifHandler = mux.onNotification.mock.calls[0][0]
      notifHandler('pty.data', { id: 'pty-1', data: 'output' })

      expect(handler).not.toHaveBeenCalled()
    })

    it('supports multiple listeners', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      provider.onData(handler1)
      provider.onData(handler2)

      const notifHandler = mux.onNotification.mock.calls[0][0]
      notifHandler('pty.data', { id: 'pty-1', data: 'output' })

      expect(handler1).toHaveBeenCalled()
      expect(handler2).toHaveBeenCalled()
    })
  })
})
