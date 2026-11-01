import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { resetSshConnectionMocks, spawnSystemSshCommandMock } from './ssh-connection-test-harness'
import { createCallbacks, createResolvedConfig, createTarget } from './ssh-connection-test-fixtures'
import type { createSystemCommandChannel } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { resolveWithSshG } from '../config/ssh-g-config-resolution'

vi.mock('../ssh2-module-load', async () =>
  (await import('../__tests__/ssh-connection-test-client')).createSsh2LoaderModule()
)
vi.mock('../system-transport/system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('../system-transport/system-ssh-args', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshArgsMocks(await importOriginal())
)
vi.mock('../system-transport/system-ssh-command', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshCommandMocks(await importOriginal())
)
vi.mock('../system-transport/system-ssh-file-binary-transfer', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshFileBinaryTransferMocks(
    await importOriginal()
  )
)
vi.mock('../system-transport/system-ssh-file-transfer', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshFileTransferMocks(
    await importOriginal()
  )
)
vi.mock('../ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('../config/ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)
vi.mock('../config/ssh-g-config-resolution', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSshGConfigResolutionMocks(
    await importOriginal()
  )
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
