import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  getOrcaControlSocketPathMock,
  removeControlSocketPathMock,
  resetSshConnectionMocks,
  spawnSystemSshCommandMock,
  spawnSystemSshMock
} from './ssh-connection-test-harness'
import {
  createCallbacks,
  createFailingSystemSshProcess,
  createPendingSystemSshProcess,
  createResolvedConfig,
  createSystemSshProcess,
  createTarget
} from './ssh-connection-test-fixtures'
import type { createSystemCommandChannel } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { resolveWithSshG, type SshResolvedConfig } from './ssh-config-parser'
import type { SshTarget } from '../../shared/ssh-types'

vi.mock('ssh2', async () => (await import('./ssh-connection-test-harness')).createSsh2Module())
vi.mock('./system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('./ssh-system-fallback', async () =>
  (await import('./ssh-connection-test-harness')).createSystemFallbackModule()
)
vi.mock('./ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('./ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)

describe('SshConnection', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
  })

  it('removes system SSH probe listeners after timeout', async () => {
    vi.useFakeTimers()
    const channel = new EventEmitter() as ReturnType<typeof createSystemCommandChannel>
    channel.stdin = { end: vi.fn(), write: vi.fn() }
    channel.stderr = new EventEmitter()
    channel.close = vi.fn()
    spawnSystemSshCommandMock.mockReturnValueOnce(channel)
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    try {
      const connect = expect(conn.connect()).rejects.toThrow('System SSH connection timed out')
      await vi.advanceTimersByTimeAsync(30_000)

      await connect
      expect(channel.close).toHaveBeenCalled()
      expect(channel.listenerCount('data')).toBe(0)
      expect(channel.listenerCount('error')).toBe(1)
      expect(channel.listenerCount('close')).toBe(1)
      expect(channel.stderr.listenerCount('data')).toBe(0)
      expect(
        (conn as unknown as { systemCommandChannels: Set<unknown> }).systemCommandChannels.size
      ).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes resolved OpenSSH config to direct system SSH connections', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    await conn.connectViaSystemSsh()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
    expect(spawnSystemSshMock).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'fdpass-host' }),
      {
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      }
    )
  })

  it('retries direct system SSH connections without ControlMaster after mux startup failure', async () => {
    getOrcaControlSocketPathMock.mockImplementation(
      (_target: SshTarget, options?: { disableControlMaster?: boolean }) =>
        options?.disableControlMaster ? null : '/tmp/orca-ssh-501/stale-socket'
    )
    spawnSystemSshMock
      .mockReturnValueOnce(createFailingSystemSshProcess(255))
      .mockImplementation(() => createSystemSshProcess())
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    await conn.connectViaSystemSsh()

    expect(removeControlSocketPathMock).toHaveBeenCalledWith('/tmp/orca-ssh-501/stale-socket')
    expect(spawnSystemSshMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ configHost: 'fdpass-host' }),
      {
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      }
    )
    expect(spawnSystemSshMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ configHost: 'fdpass-host' }),
      {
        disableControlMaster: true,
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      }
    )
    expect(conn.canRunConcurrentExecCommands()).toBe(false)
  })

  it.each([
    'Permission denied (publickey,password).',
    'Encrypted private key detected, but no passphrase given'
  ])('skips a direct retry for terminal credential failures: %s', async (message) => {
    getOrcaControlSocketPathMock.mockReturnValue('/tmp/orca-ssh-501/stale-socket')
    spawnSystemSshMock.mockImplementation(() => {
      throw new Error(message)
    })
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    await expect(conn.connectViaSystemSsh()).rejects.toThrow(message)
    expect(spawnSystemSshMock).toHaveBeenCalledTimes(1)
    expect(removeControlSocketPathMock).toHaveBeenCalledWith('/tmp/orca-ssh-501/stale-socket')
  })

  it('kills delayed direct system SSH startup on disconnect and ignores late stdout', async () => {
    const proc = createPendingSystemSshProcess()
    spawnSystemSshMock.mockReturnValueOnce(proc)
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), callbacks)

    const connectResult = conn.connectViaSystemSsh().catch((err: Error) => err)
    for (let i = 0; i < 5 && spawnSystemSshMock.mock.calls.length === 0; i++) {
      await Promise.resolve()
    }
    expect(spawnSystemSshMock).toHaveBeenCalledTimes(1)

    await conn.disconnect()

    expect(proc.kill).toHaveBeenCalled()
    proc.stdout.emit('data', Buffer.from('ORCA-SYSTEM-SSH-READY'))

    await expect(connectResult).resolves.toMatchObject({
      message: 'SSH connection attempt was cancelled'
    })
    expect(conn.getState().status).toBe('disconnected')
    expect(conn.usesSystemSshTransport()).toBe(false)
    expect(callbacks.onStateChange).not.toHaveBeenCalledWith(
      'target-1',
      expect.objectContaining({ status: 'connected' })
    )
  })

  it('treats delayed direct system SSH exit after disconnect as cancellation', async () => {
    const proc = createPendingSystemSshProcess()
    let capturedExit: ((exitCode: number | null) => void) | null = null
    proc.onExit = vi.fn((handler: (exitCode: number | null) => void) => {
      capturedExit = handler
    })
    proc.kill = vi.fn(() => {
      queueMicrotask(() => capturedExit?.(null))
    })
    spawnSystemSshMock.mockReturnValueOnce(proc)
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), callbacks)

    const connectResult = conn.connectViaSystemSsh().catch((err: Error) => err)
    for (let i = 0; i < 5 && spawnSystemSshMock.mock.calls.length === 0; i++) {
      await Promise.resolve()
    }
    expect(spawnSystemSshMock).toHaveBeenCalledTimes(1)

    await conn.disconnect()

    const result = await connectResult
    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) {
      throw new Error('Expected direct system SSH startup to reject')
    }
    expect(result.message).toBe('SSH connection attempt was cancelled')
    expect(conn.getState()).toMatchObject({ status: 'disconnected', error: null })
    expect(conn.usesSystemSshTransport()).toBe(false)
    expect(callbacks.onStateChange).not.toHaveBeenCalledWith(
      'target-1',
      expect.objectContaining({ status: 'error' })
    )
    expect(callbacks.onStateChange).not.toHaveBeenCalledWith(
      'target-1',
      expect.objectContaining({ status: 'connected' })
    )
  })

  it('does not spawn direct system SSH after disconnect while OpenSSH config is resolving', async () => {
    let resolveConfig!: (config: SshResolvedConfig | null) => void
    vi.mocked(resolveWithSshG).mockReturnValueOnce(
      new Promise<SshResolvedConfig | null>((resolve) => {
        resolveConfig = resolve
      })
    )
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    const connectResult = conn.connectViaSystemSsh().catch((err: Error) => err)
    await Promise.resolve()
    await conn.disconnect()
    resolveConfig(createResolvedConfig())

    await expect(connectResult).resolves.toMatchObject({
      message: 'SSH connection attempt was cancelled'
    })
    expect(spawnSystemSshMock).not.toHaveBeenCalled()
    expect(conn.getState().status).toBe('disconnected')
  })

  it('does not spawn direct system SSH retry after cancellation between mux failure and retry', async () => {
    getOrcaControlSocketPathMock.mockReturnValue('/tmp/orca-ssh-501/stale-socket')
    const firstProc = createPendingSystemSshProcess()
    let conn!: SshConnection
    firstProc.onExit = vi.fn((handler: (exitCode: number | null) => void) => {
      queueMicrotask(() => {
        handler(255)
        void conn.disconnect()
      })
    })
    spawnSystemSshMock
      .mockReturnValueOnce(firstProc)
      .mockImplementation(() => createSystemSshProcess())
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    const result = await conn.connectViaSystemSsh().catch((err: Error) => err)

    expect(result).toMatchObject({ message: 'SSH connection attempt was cancelled' })
    expect(spawnSystemSshMock).toHaveBeenCalledTimes(1)
    expect(conn.getState().status).toBe('disconnected')
  })
})
