import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSshConnectionMocks } from './ssh-connection-test-harness'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'

const { startForwardMock, waitForwardMock } = vi.hoisted(() => ({
  startForwardMock: vi.fn(),
  waitForwardMock: vi.fn()
}))

vi.mock('ssh2', async () =>
  (await import('../__tests__/ssh-connection-test-client')).createSsh2Module()
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
// Why: admission would otherwise run this machine's ssh -G and ssh-add.
vi.mock('../system-transport/system-ssh-loopback-route-admission', () => ({
  admitSystemSshLoopbackRoute: async () => ({
    admitted: true,
    sshdPort: 22,
    hostKeyAlias: 'example.com'
  })
}))
vi.mock('../system-transport/system-ssh-loopback-route', async (importOriginal) => ({
  ...(await importOriginal()),
  shouldUseSystemSshLoopbackRoute: () => true
}))
vi.mock('../system-transport/system-ssh-forward-process', () => ({
  startSystemSshPortForwardProcess: startForwardMock,
  waitForSystemSshForwardStartup: waitForwardMock
}))

describe('pending real loopback route startup ownership', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
    startForwardMock.mockReset()
    waitForwardMock.mockReset()
  })
  it('disconnect stops the already spawned forward before startup completes', async () => {
    resetSshConnectionMocks()
    const dispose = vi.fn()
    const process = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      stderr: new PassThrough()
    })
    startForwardMock.mockResolvedValue({ process, localPort: 50001, dispose })
    let failStartup = (_error: Error): void => {}
    waitForwardMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failStartup = reject
        })
    )
    const conn = new SshConnection(
      createTarget({ proxyCommand: 'ssh -W %h:%p bastion.example.com' }),
      createCallbacks()
    )
    await conn.connect()
    await vi.waitFor(() => expect(waitForwardMock).toHaveBeenCalled())
    await conn.disconnect()
    const stoppedAtDisconnect = dispose.mock.calls.length
    failStartup(new Error('review cleanup: interrupted slow handshake'))
    await vi.waitFor(() => expect(dispose).toHaveBeenCalled())
    expect(stoppedAtDisconnect).toBeGreaterThan(0)
  })
  it('cancels the superseded forward while keeping the new startup owned', async () => {
    const createForward = () => ({
      process: Object.assign(new EventEmitter(), {
        pid: undefined,
        exitCode: null,
        signalCode: null
      }),
      localPort: 50001,
      dispose: vi.fn()
    })
    const stale = createForward()
    const current = createForward()
    startForwardMock.mockResolvedValueOnce(stale).mockResolvedValueOnce(current)
    const failures: ((error: Error) => void)[] = []
    waitForwardMock.mockImplementation(
      () => new Promise((_resolve, reject) => failures.push(reject))
    )
    const conn = new SshConnection(
      createTarget({ proxyCommand: 'ssh -W %h:%p bastion.example.com' }),
      createCallbacks()
    )
    await conn.connect()
    await vi.waitFor(() => expect(waitForwardMock).toHaveBeenCalledTimes(1))
    await conn.reconnect()
    await vi.waitFor(() => expect(waitForwardMock).toHaveBeenCalledTimes(2))
    expect(stale.dispose).toHaveBeenCalledTimes(1)
    expect(current.dispose).not.toHaveBeenCalled()
    failures[0]?.(new Error('superseded handshake'))
    await Promise.resolve()
    await Promise.resolve()
    await conn.disconnect()
    expect(current.dispose).toHaveBeenCalledTimes(1)
    failures[1]?.(new Error('disconnected handshake'))
    await Promise.resolve()
    expect(conn.getSystemSshBuildArgsOptions().loopbackRoute).toBeUndefined()
  })
})
