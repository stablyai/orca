import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSshConnectionMocks } from './testing/ssh-connection-test-harness'
import { createCallbacks, createTarget } from './testing/ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'

const { startForwardMock, waitForwardMock } = vi.hoisted(() => ({
  startForwardMock: vi.fn(),
  waitForwardMock: vi.fn()
}))

vi.mock('../authentication/ssh2-module-load', async () =>
  (await import('./testing/ssh-connection-test-client')).createSsh2LoaderModule()
)
vi.mock('../system-transport/system-ssh-binary', async () =>
  (await import('./testing/ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('../system-transport/system-ssh-args', async (importOriginal) =>
  (await import('./testing/ssh-connection-test-harness')).withSystemSshArgsMocks(
    await importOriginal()
  )
)
vi.mock('../system-transport/system-ssh-command', async (importOriginal) =>
  (await import('./testing/ssh-connection-test-harness')).withSystemSshCommandMocks(
    await importOriginal()
  )
)
vi.mock('../system-transport/ssh-control-socket', async () =>
  (await import('./testing/ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('../config/ssh-config-parser', async () =>
  (await import('./testing/ssh-connection-test-harness')).createSshConfigParserModule()
)
vi.mock('../config/ssh-g-config-resolution', async (importOriginal) =>
  (await import('./testing/ssh-connection-test-harness')).withSshGConfigResolutionMocks(
    await importOriginal()
  )
)
// Keep admission from invoking this machine's real ssh -G/ssh-add.
vi.mock('../system-transport/forwarding/system-ssh-loopback-route-admission', () => ({
  admitSystemSshLoopbackRoute: async () => ({
    admitted: true,
    sshdPort: 22,
    hostKeyAlias: 'example.com'
  })
}))
vi.mock('../system-transport/forwarding/system-ssh-loopback-route', async (importOriginal) => ({
  ...(await importOriginal()),
  shouldUseSystemSshLoopbackRoute: () => true
}))
vi.mock('../system-transport/forwarding/system-ssh-forward-process', () => ({
  startSystemSshPortForwardProcess: startForwardMock,
  waitForSystemSshForwardStartup: waitForwardMock
}))

describe('pending real loopback route startup ownership', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
    startForwardMock.mockReset()
    waitForwardMock.mockReset()
  })
  it('cancels the superseded forward and disposes the replacement on disconnect', async () => {
    const createForward = () => ({
      process: Object.assign(new EventEmitter(), {
        pid: undefined,
        exitCode: null,
        signalCode: null,
        kill: vi.fn(() => true)
      }),
      localPort: 50001,
      dispose: vi.fn()
    })
    // Windows stops a forward through a process-tree kill instead of dispose.
    const stopped = (forward: ReturnType<typeof createForward>) =>
      process.platform === 'win32' ? forward.process.kill : forward.dispose
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
    expect(stopped(stale)).toHaveBeenCalledTimes(1)
    expect(stopped(current)).not.toHaveBeenCalled()
    failures[0]?.(new Error('superseded handshake'))
    await Promise.resolve()
    await Promise.resolve()
    await conn.disconnect()
    expect(stopped(current)).toHaveBeenCalledTimes(1)
    failures[1]?.(new Error('disconnected handshake'))
    await Promise.resolve()
    expect(conn.getSystemSshBuildArgsOptions().loopbackRoute).toBeUndefined()
  })
})
