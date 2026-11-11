import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSshConnectionMocks } from './testing/ssh-connection-test-harness'
import { createCallbacks, createTarget } from './testing/ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import type { SystemSshLoopbackRoute } from '../system-transport/forwarding/system-ssh-loopback-route'

const { startRouteMock } = vi.hoisted(() => ({ startRouteMock: vi.fn() }))

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
vi.mock(
  '../system-transport/file-transfer/system-ssh-file-binary-transfer',
  async (importOriginal) =>
    (await import('./testing/ssh-connection-test-harness')).withSystemSshFileBinaryTransferMocks(
      await importOriginal()
    )
)
vi.mock('../config/ssh-config-parser', async () =>
  (await import('./testing/ssh-connection-test-harness')).createSshConfigParserModule()
)
vi.mock('../config/ssh-g-config-resolution', async (importOriginal) =>
  (await import('./testing/ssh-connection-test-harness')).withSshGConfigResolutionMocks(
    await importOriginal()
  )
)
// Force the Windows-gated route on here to exercise lifecycle; its own suite covers selection.
vi.mock('../system-transport/forwarding/system-ssh-loopback-route', () => ({
  shouldUseSystemSshLoopbackRoute: () => true,
  startSystemSshLoopbackRoute: startRouteMock
}))

function createRoute(localPort: number): SystemSshLoopbackRoute {
  return {
    args: { localPort, hostKeyAlias: 'example.com' },
    onExit: vi.fn(),
    dispose: vi.fn()
  }
}

function deferRouteStart(): (route: SystemSshLoopbackRoute) => void {
  let resolveRoute: (route: SystemSshLoopbackRoute) => void = () => undefined
  startRouteMock.mockImplementationOnce(
    () =>
      new Promise<SystemSshLoopbackRoute>((resolve) => {
        resolveRoute = resolve
      })
  )
  return (route) => resolveRoute(route)
}

describe('SshConnection loopback route', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
    startRouteMock.mockReset()
  })

  it('still builds a route for a reconnect that superseded a start in flight', async () => {
    const finishStaleStart = deferRouteStart()
    const finishCurrentStart = deferRouteStart()
    const conn = new SshConnection(
      createTarget({ proxyCommand: 'ssh -W %h:%p bastion.example.com' }),
      createCallbacks()
    )
    await conn.connect()

    await conn.reconnect()
    expect(conn.getState().status).toBe('connected')
    expect(startRouteMock).toHaveBeenCalledTimes(2)

    const stale = createRoute(50001)
    finishStaleStart(stale)
    await vi.waitFor(() => expect(stale.dispose).toHaveBeenCalled())
    expect(conn.getSystemSshBuildArgsOptions().loopbackRoute).toBeUndefined()

    finishCurrentStart(createRoute(50002))
    await vi.waitFor(() =>
      expect(conn.getSystemSshBuildArgsOptions().loopbackRoute?.localPort).toBe(50002)
    )
  })

  it('does not start a route for a connection torn down as it reported connected', async () => {
    let conn: SshConnection | null = null
    conn = new SshConnection(
      createTarget({ proxyCommand: 'ssh -W %h:%p bastion.example.com' }),
      createCallbacks({
        onStateChange: (_id, state) => {
          if (state.status === 'connected') {
            void conn?.disconnect({ quiet: true })
          }
        }
      })
    )

    await conn.connect().catch(() => undefined)

    expect(startRouteMock).not.toHaveBeenCalled()
  })
})
