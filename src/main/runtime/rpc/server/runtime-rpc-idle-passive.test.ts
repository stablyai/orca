import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { OrcaRuntimeService } from '../../orca-runtime'
import { IDLE_PASSIVE_CLIENT_CAPABILITY } from '../../../../shared/remote-runtime/protocol/orcad-runtime-capabilities'

type SocketWiringOptions = {
  onText: (socket: unknown, plaintext: string, reply: () => void, sendBinary: () => void) => void
}
const wiringOptions: SocketWiringOptions[] = []
vi.mock('../mobile/mobile-socket-wiring', () => ({
  MobileSocketWiring: class {
    constructor(options: SocketWiringOptions) {
      wiringOptions.push(options)
    }
  }
}))

function createServer(): OrcaRuntimeRpcServer {
  return new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-idle-passive-')),
    enableWebSocket: false
  })
}

describe('managed idle exit and passive watcher sockets', () => {
  it('does not count an open passive socket as a client', () => {
    const server = createServer()
    // One passive watcher is connected: the wiring knows it, but it must not block idle exit.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readClientActivity reads only these two counts.
    server['mobileSocketWiring'] = { connectionCount: 1, idleBlockingConnectionCount: 0 } as never

    expect(server.readClientActivity().openConnections).toBe(0)
  })

  it('does not count a passive socket’s requests, or let them reset the idle clock', async () => {
    const server = createServer()
    const passive = { clientCapabilities: [IDLE_PASSIVE_CLIENT_CAPABILITY] }
    const desktop = { clientCapabilities: [] }
    const quietSince = server.readClientActivity().lastRequestAt
    let finish = (): void => {}
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })

    const passiveRequest = server['trackSocketRequest'](passive, () => pending)
    expect(server.readClientActivity()).toMatchObject({
      requestsInFlight: 0,
      lastRequestAt: quietSince
    })

    const desktopRequest = server['trackSocketRequest'](desktop, () => pending)
    expect(server.readClientActivity().requestsInFlight).toBe(1)
    finish()
    await Promise.all([passiveRequest, desktopRequest])
  })

  it('routes socket messages through the passive-aware request count', () => {
    const server = createServer()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked wiring ignores both.
    server['ensureMobileSocketWiring']({} as never, {} as never)
    const { onText } = wiringOptions.at(-1)!
    const socket = (clientCapabilities: string[]) => ({
      ws: {},
      device: { deviceId: 'd' },
      clientCapabilities
    })

    onText(
      socket([IDLE_PASSIVE_CLIENT_CAPABILITY]),
      '{}',
      () => {},
      () => {}
    )
    expect(server.readClientActivity().requestsInFlight).toBe(0)
    onText(
      socket([]),
      '{}',
      () => {},
      () => {}
    )
    expect(server.readClientActivity().requestsInFlight).toBe(1)
  })
})
