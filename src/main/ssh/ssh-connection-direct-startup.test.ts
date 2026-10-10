import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { resetSshConnectionMocks, spawnSystemSshCommandMock } from './ssh-connection-test-harness'
import { createCallbacks, createResolvedConfig, createTarget } from './ssh-connection-test-fixtures'
import type { createSystemCommandChannel } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { resolveWithSshG } from './ssh-config-parser'

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
      // Lifetime observers remain until physical close, even after the probe timed out.
      expect(channel.listenerCount('error')).toBe(2)
      expect(channel.listenerCount('close')).toBe(2)
      expect(channel.stderr.listenerCount('data')).toBe(0)
      expect(
        (conn as unknown as { systemCommandChannels: Set<unknown> }).systemCommandChannels.size
      ).toBe(0)
      channel.emit('close', 0)
      expect(channel.listenerCount('close')).toBe(0)
      expect(channel.listenerCount('error')).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
