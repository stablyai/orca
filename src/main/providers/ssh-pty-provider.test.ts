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
  const scopedPty1 = 'ssh:conn-1@@pty-1'

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
      expect(result).toEqual({ id: scopedPty1 })
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

    it('injects the relay-backed Orca CLI bridge into remote PTY env', async () => {
      mux.request.mockResolvedValue({ id: 'pty-bridge' })
      provider = new SshPtyProvider('conn-1', mux as never, {
        binDir: '/home/user/.orca-relay/bin',
        relayDir: '/home/user/.orca-relay/relay-v1',
        nodePath: '/usr/bin/node',
        sockPath: '/home/user/.orca-relay/relay.sock'
      })

      await provider.spawn({
        cols: 120,
        rows: 40,
        env: { PATH: '/usr/bin', ORCA_TERMINAL_HANDLE: 'term_ssh' }
      })

      expect(mux.request).toHaveBeenCalledWith('pty.spawn', {
        cols: 120,
        rows: 40,
        cwd: undefined,
        env: {
          PATH: '/home/user/.orca-relay/bin:/usr/bin',
          ORCA_TERMINAL_HANDLE: 'term_ssh',
          ORCA_REMOTE_CLI_BIN_DIR: '/home/user/.orca-relay/bin',
          ORCA_RELAY_DIR: '/home/user/.orca-relay/relay-v1',
          ORCA_RELAY_NODE_PATH: '/usr/bin/node',
          ORCA_RELAY_SOCKET_PATH: '/home/user/.orca-relay/relay.sock'
        }
      })
    })

    it('does not clobber the remote relay PATH when caller env has no PATH', async () => {
      mux.request.mockResolvedValue({ id: 'pty-bridge' })
      provider = new SshPtyProvider('conn-1', mux as never, {
        binDir: '/home/user/.orca-relay/bin',
        relayDir: '/home/user/.orca-relay/relay-v1',
        nodePath: '/usr/bin/node',
        sockPath: '/home/user/.orca-relay/relay.sock'
      })

      await provider.spawn({
        cols: 120,
        rows: 40,
        env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
      })

      expect(mux.request).toHaveBeenCalledWith('pty.spawn', {
        cols: 120,
        rows: 40,
        cwd: undefined,
        env: {
          ORCA_TERMINAL_HANDLE: 'term_ssh',
          ORCA_REMOTE_CLI_BIN_DIR: '/home/user/.orca-relay/bin',
          ORCA_RELAY_DIR: '/home/user/.orca-relay/relay-v1',
          ORCA_RELAY_NODE_PATH: '/usr/bin/node',
          ORCA_RELAY_SOCKET_PATH: '/home/user/.orca-relay/relay.sock'
        }
      })
    })

    it('uses Windows PATH delimiters for native Windows SSH bridge env', async () => {
      mux.request.mockResolvedValue({ id: 'pty-bridge' })
      provider = new SshPtyProvider('conn-1', mux as never, {
        binDir: 'C:/Users/me/.orca-relay/bin',
        relayDir: 'C:/Users/me/.orca-remote/relay-v1',
        nodePath: 'C:/Program Files/nodejs/node.exe',
        sockPath: '\\\\.\\pipe\\orca-relay-123',
        pathDelimiter: ';'
      })

      await provider.spawn({
        cols: 120,
        rows: 40,
        env: { Path: 'C:/Windows/System32;C:/Tools' }
      })

      expect(mux.request).toHaveBeenCalledWith('pty.spawn', {
        cols: 120,
        rows: 40,
        cwd: undefined,
        env: {
          Path: 'C:/Users/me/.orca-relay/bin;C:/Windows/System32;C:/Tools',
          ORCA_REMOTE_CLI_BIN_DIR: 'C:/Users/me/.orca-relay/bin',
          ORCA_RELAY_DIR: 'C:/Users/me/.orca-remote/relay-v1',
          ORCA_RELAY_NODE_PATH: 'C:/Program Files/nodejs/node.exe',
          ORCA_RELAY_SOCKET_PATH: '\\\\.\\pipe\\orca-relay-123'
        }
      })
    })

    it('reattaches an existing session and returns attach replay separately from snapshot', async () => {
      mux.request.mockResolvedValue({ replay: 'buffered-output' })

      const result = await provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })

      expect(mux.request).toHaveBeenCalledWith('pty.attach', {
        id: 'pty-old',
        cols: 80,
        rows: 24,
        suppressReplayNotification: true
      })
      expect(result).toEqual({
        id: 'ssh:conn-1@@pty-old',
        isReattach: true,
        replay: 'buffered-output'
      })
    })

    it('reattaches scoped app ids using raw relay ids', async () => {
      mux.request.mockResolvedValue({ replay: 'buffered-output' })

      const result = await provider.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'ssh:conn-1@@pty-old'
      })

      expect(mux.request).toHaveBeenCalledWith('pty.attach', {
        id: 'pty-old',
        cols: 80,
        rows: 24,
        suppressReplayNotification: true
      })
      expect(result).toEqual({
        id: 'ssh:conn-1@@pty-old',
        isReattach: true,
        replay: 'buffered-output'
      })
    })

    it('does not fresh-spawn over an expired reattach session', async () => {
      mux.request.mockRejectedValueOnce(new Error('PTY "pty-old" not found'))

      await expect(provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })).rejects.toThrow(
        'SSH_SESSION_EXPIRED: pty-old'
      )

      expect(mux.request).toHaveBeenNthCalledWith(1, 'pty.attach', {
        id: 'pty-old',
        cols: 80,
        rows: 24,
        suppressReplayNotification: true
      })
      expect(mux.request).toHaveBeenCalledTimes(1)
    })

    it('preserves transient reattach failures for retry handling', async () => {
      mux.request.mockRejectedValueOnce(new Error('SSH connection lost, reconnecting...'))

      await expect(provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })).rejects.toThrow(
        'SSH connection lost, reconnecting...'
      )

      expect(mux.request).toHaveBeenCalledTimes(1)
    })
  })

  it('attach sends pty.attach request', async () => {
    await provider.attach(scopedPty1)
    expect(mux.request).toHaveBeenCalledWith('pty.attach', { id: 'pty-1' })
  })

  it('write sends pty.data notification', () => {
    provider.write(scopedPty1, 'hello')
    expect(mux.notify).toHaveBeenCalledWith('pty.data', { id: 'pty-1', data: 'hello' })
  })

  it('resize sends pty.resize notification', () => {
    provider.resize(scopedPty1, 120, 40)
    expect(mux.notify).toHaveBeenCalledWith('pty.resize', { id: 'pty-1', cols: 120, rows: 40 })
  })

  it('shutdown sends pty.shutdown request', async () => {
    await provider.shutdown(scopedPty1, { immediate: true })
    expect(mux.request).toHaveBeenCalledWith('pty.shutdown', {
      id: 'pty-1',
      immediate: true,
      keepHistory: false
    })
  })

  it('shutdown forwards keepHistory: true over the relay', async () => {
    await provider.shutdown(scopedPty1, { immediate: true, keepHistory: true })
    expect(mux.request).toHaveBeenCalledWith('pty.shutdown', {
      id: 'pty-1',
      immediate: true,
      keepHistory: true
    })
  })

  it('sendSignal sends pty.sendSignal request', async () => {
    await provider.sendSignal(scopedPty1, 'SIGINT')
    expect(mux.request).toHaveBeenCalledWith('pty.sendSignal', { id: 'pty-1', signal: 'SIGINT' })
  })

  it('getCwd sends pty.getCwd request', async () => {
    mux.request.mockResolvedValue('/home/user/project')
    const cwd = await provider.getCwd(scopedPty1)
    expect(cwd).toBe('/home/user/project')
    expect(mux.request).toHaveBeenCalledWith('pty.getCwd', { id: 'pty-1' })
  })

  it('clearBuffer sends pty.clearBuffer request', async () => {
    await provider.clearBuffer(scopedPty1)
    expect(mux.request).toHaveBeenCalledWith('pty.clearBuffer', { id: 'pty-1' })
  })

  it('acknowledgeDataEvent sends pty.ackData notification', () => {
    provider.acknowledgeDataEvent(scopedPty1, 1024)
    expect(mux.notify).toHaveBeenCalledWith('pty.ackData', { id: 'pty-1', charCount: 1024 })
  })

  it('hasChildProcesses sends request and returns result', async () => {
    mux.request.mockResolvedValue(true)
    const result = await provider.hasChildProcesses(scopedPty1)
    expect(result).toBe(true)
    expect(mux.request).toHaveBeenCalledWith('pty.hasChildProcesses', { id: 'pty-1' })
  })

  it('getForegroundProcess returns process name', async () => {
    mux.request.mockResolvedValue('node')
    const result = await provider.getForegroundProcess(scopedPty1)
    expect(result).toBe('node')
    expect(mux.request).toHaveBeenCalledWith('pty.getForegroundProcess', { id: 'pty-1' })
  })

  it('serializes scoped app ids using raw relay ids', async () => {
    mux.request.mockResolvedValue('serialized')

    const result = await provider.serialize([scopedPty1])

    expect(result).toBe('serialized')
    expect(mux.request).toHaveBeenCalledWith('pty.serialize', { ids: ['pty-1'] })
  })

  it('rejects scoped ids owned by another SSH connection', async () => {
    await expect(provider.shutdown('ssh:conn-2@@pty-1', { immediate: true })).rejects.toThrow(
      'belongs to SSH connection "conn-2"'
    )
  })

  it('listProcesses returns process list', async () => {
    const processes = [{ id: 'pty-1', cwd: '/home', title: 'zsh' }]
    mux.request.mockResolvedValue(processes)
    const result = await provider.listProcesses()
    expect(result).toEqual([{ id: scopedPty1, cwd: '/home', title: 'zsh' }])
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

      expect(handler).toHaveBeenCalledWith({ id: scopedPty1, data: 'output' })
    })

    it('forwards pty.replay notifications to replay listeners', () => {
      const handler = vi.fn()
      provider.onReplay(handler)

      const notifHandler = mux.onNotification.mock.calls[0][0]
      notifHandler('pty.replay', { id: 'pty-1', data: 'buffered output' })

      expect(handler).toHaveBeenCalledWith({ id: scopedPty1, data: 'buffered output' })
    })

    it('forwards pty.exit notifications to exit listeners', () => {
      const handler = vi.fn()
      provider.onExit(handler)

      const notifHandler = mux.onNotification.mock.calls[0][0]
      notifHandler('pty.exit', { id: 'pty-1', code: 0 })

      expect(handler).toHaveBeenCalledWith({ id: scopedPty1, code: 0 })
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

    it('namespaces identical relay ids from different SSH connections', () => {
      const otherMux = createMockMux()
      const otherProvider = new SshPtyProvider('conn-2', otherMux as never)
      const firstHandler = vi.fn()
      const secondHandler = vi.fn()
      provider.onData(firstHandler)
      otherProvider.onData(secondHandler)

      mux.onNotification.mock.calls[0][0]('pty.data', { id: 'pty-1', data: 'first' })
      otherMux.onNotification.mock.calls[0][0]('pty.data', { id: 'pty-1', data: 'second' })

      expect(firstHandler).toHaveBeenCalledWith({ id: scopedPty1, data: 'first' })
      expect(secondHandler).toHaveBeenCalledWith({ id: 'ssh:conn-2@@pty-1', data: 'second' })
    })
  })
})
