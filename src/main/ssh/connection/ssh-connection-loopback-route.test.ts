import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSshConnectionMocks } from './ssh-connection-test-harness'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import type { SystemSshLoopbackRoute } from '../system-transport/system-ssh-loopback-route'
import { uploadFileViaSystemSsh } from '../system-transport/system-ssh-file-binary-transfer'

const { startRouteMock } = vi.hoisted(() => ({ startRouteMock: vi.fn() }))

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
vi.mock('../system-transport/system-ssh-file-binary-transfer', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshFileBinaryTransferMocks(
    await importOriginal()
  )
)
vi.mock('../config/ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)
vi.mock('../config/ssh-g-config-resolution', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSshGConfigResolutionMocks(
    await importOriginal()
  )
)
// Force the Windows-gated route on here to exercise lifecycle; its own suite covers selection.
vi.mock('../system-transport/system-ssh-loopback-route', () => ({
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

  it('routes later commands through the route once it is proven', async () => {
    const finishStart = deferRouteStart()
    const conn = new SshConnection(
      createTarget({ proxyCommand: 'ssh -W %h:%p bastion.example.com' }),
      createCallbacks()
    )

    await conn.connect()
    expect(conn.getSystemSshBuildArgsOptions().loopbackRoute).toBeUndefined()

    finishStart(createRoute(50001))
    await vi.waitFor(() =>
      expect(conn.getSystemSshBuildArgsOptions().loopbackRoute).toEqual({
        localPort: 50001,
        hostKeyAlias: 'example.com'
      })
    )
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

  it('drops the route when its forward exits, so commands fall back to the proxy', async () => {
    const finishStart = deferRouteStart()
    const conn = new SshConnection(
      createTarget({ proxyCommand: 'ssh -W %h:%p bastion.example.com' }),
      createCallbacks()
    )
    await conn.connect()
    const route = createRoute(50001)
    finishStart(route)
    await vi.waitFor(() => expect(route.onExit).toHaveBeenCalled())

    const onExit = vi.mocked(route.onExit).mock.calls[0]?.[0]
    onExit?.()

    expect(conn.getSystemSshBuildArgsOptions().loopbackRoute).toBeUndefined()
  })

  it('stops an open upload session from dialling a route that has since exited', async () => {
    const finishStart = deferRouteStart()
    const conn = new SshConnection(
      createTarget({ proxyCommand: 'ssh -W %h:%p bastion.example.com' }),
      createCallbacks()
    )
    await conn.connect()
    const route = createRoute(50001)
    finishStart(route)
    await vi.waitFor(() => expect(route.onExit).toHaveBeenCalled())
    const uploadSession = await conn.openFileUploadSession()

    vi.mocked(route.onExit).mock.calls[0]?.[0]?.()
    await uploadSession.uploadFile('/tmp/a.txt', '/remote/a.txt')

    expect(vi.mocked(uploadFileViaSystemSsh).mock.calls.at(-1)?.[3]?.loopbackRoute).toBeUndefined()
  })

  it('disposes the route on disconnect', async () => {
    const finishStart = deferRouteStart()
    const conn = new SshConnection(
      createTarget({ proxyCommand: 'ssh -W %h:%p bastion.example.com' }),
      createCallbacks()
    )
    await conn.connect()
    const route = createRoute(50001)
    finishStart(route)
    await vi.waitFor(() => expect(conn.getSystemSshBuildArgsOptions().loopbackRoute).toBeDefined())

    await conn.disconnect()

    expect(route.dispose).toHaveBeenCalled()
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
