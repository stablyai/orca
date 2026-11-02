import { EventEmitter, once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { connect, createServer, type AddressInfo, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '../ssh/connection/ssh-connection'
import type { SshProviderEpoch } from '../../shared/ssh-types'
import { resolveSshBrowserNetworkExecutionRoute } from './ssh-browser-network-execution-route'
import { setNetworkProxySettingsSource } from './browser-network-proxy-settings-source'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'
import { RemoteBrowserSocksServer } from './remote-browser-socks-server'

const executionHost = {
  kind: 'ssh' as const,
  targetId: 'target-a',
  providerEpoch: 'provider-epoch-a',
  connectionGeneration: 2
}

function fakeConnection(client: unknown): SshConnection {
  return {
    getState: () => ({
      targetId: 'target-a',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }),
    getClient: () => client,
    usesSystemSshTransport: () => client === null,
    getTarget: () => ({
      id: 'target-a',
      label: 'Target A',
      host: 'ssh.example.com',
      port: 22,
      username: 'orca'
    }),
    getSystemSshBuildArgsOptions: () => ({})
  } as unknown as SshConnection
}

const servers: ReturnType<typeof createServer>[] = []
const noHostProxy = async (): Promise<Record<string, string>> => ({})

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

describe('SSH browser network execution route', () => {
  it('rejects an unavailable or stale authority before opening a destination', async () => {
    const connection = fakeConnection({ forwardOut: vi.fn() })
    const registerAuthorityAbort = vi.fn()

    await expect(
      resolveSshBrowserNetworkExecutionRoute(
        { executionHost, runtimeId: 'runtime-a', runtimeRevision: 1 },
        {
          connectionManager: { getConnection: () => connection },
          isCurrentAuthority: () => false,
          registerAuthorityAbort
        }
      )
    ).rejects.toThrow('browser_tunnel_execution_host_unavailable')
    expect(registerAuthorityAbort).not.toHaveBeenCalled()
  })

  it('passes the exact domain and port to ssh2 forwardOut and fences rotation', async () => {
    const channel = new PassThrough() as PassThrough & { close: ReturnType<typeof vi.fn> }
    channel.close = vi.fn(() => channel.destroy())
    const forwardOut = vi.fn(
      (
        _sourceHost: string,
        _sourcePort: number,
        _host: string,
        _port: number,
        callback: (error: Error | undefined, channel: PassThrough) => void
      ) => callback(undefined, channel)
    )
    const connection = fakeConnection({ forwardOut })
    let current = true
    let authorityAbort: AbortController | undefined
    const removeAuthorityAbort = vi.fn()
    const route = await resolveSshBrowserNetworkExecutionRoute(
      { executionHost, runtimeId: 'runtime-a', runtimeRevision: 1 },
      {
        connectionManager: { getConnection: () => connection },
        isCurrentAuthority: (authority) =>
          current &&
          authority.providerEpoch === ('provider-epoch-a' as SshProviderEpoch) &&
          authority.connectionGeneration === 2,
        registerAuthorityAbort: (_authority, controller) => {
          authorityAbort = controller
          return removeAuthorityAbort
        },
        readHostProxyEnvironment: noHostProxy
      }
    )

    const socket = route.connect({ host: 'split-horizon.internal', port: 8443 })
    await once(socket as unknown as EventEmitter, 'connect')
    expect(forwardOut).toHaveBeenCalledWith(
      '127.0.0.1',
      0,
      'split-horizon.internal',
      8443,
      expect.any(Function)
    )

    current = false
    authorityAbort?.abort()
    await route.whenInvalidated
    expect(route.isValid()).toBe(false)
    await route.close()
    await route.close()
    expect(removeAuthorityAbort).toHaveBeenCalledOnce()
    expect(socket.destroyed).toBe(true)
  })

  it('does not adopt a replacement ssh2 client under the captured authority', async () => {
    const firstForwardOut = vi.fn()
    const secondForwardOut = vi.fn()
    let client = { forwardOut: firstForwardOut }
    const connection = {
      getState: () => ({
        targetId: 'target-a',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      }),
      getClient: () => client,
      usesSystemSshTransport: () => false
    } as unknown as SshConnection
    const route = await resolveSshBrowserNetworkExecutionRoute(
      { executionHost, runtimeId: 'runtime-a', runtimeRevision: 1 },
      {
        connectionManager: { getConnection: () => connection },
        isCurrentAuthority: () => true,
        registerAuthorityAbort: () => () => {},
        readHostProxyEnvironment: noHostProxy
      }
    )

    client = { forwardOut: secondForwardOut }
    const socket = route.connect({ host: 'must-not-open.internal', port: 443 })
    socket.on('error', () => {})
    await vi.waitFor(() => expect(socket.destroyed).toBe(true))

    expect(route.isValid()).toBe(false)
    expect(firstForwardOut).not.toHaveBeenCalled()
    expect(secondForwardOut).not.toHaveBeenCalled()
    await route.close()
  })

  it('releases a deferred socket when forwardOut throws during disconnect', async () => {
    const forwardOut = vi.fn(() => {
      throw new Error('Not connected')
    })
    const connection = fakeConnection({ forwardOut })
    const route = await resolveSshBrowserNetworkExecutionRoute(
      { executionHost, runtimeId: 'runtime-a', runtimeRevision: 1 },
      {
        connectionManager: { getConnection: () => connection },
        isCurrentAuthority: () => true,
        registerAuthorityAbort: () => () => {},
        readHostProxyEnvironment: noHostProxy
      }
    )
    const socket = route.connect({ host: 'remote-only.internal', port: 443 })
    socket.on('error', () => {})
    const close = vi.fn()
    socket.on('close', close)

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(socket.destroyed).toBe(true)
    await route.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it('owns one system dynamic forward for the whole execution route', async () => {
    const connection = fakeConnection(null)
    const process = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
    }
    process.exitCode = null
    process.signalCode = null
    const dispose = vi.fn()
    const close = vi.fn(async () => {})
    const startDynamicForward = vi.fn(async () => ({
      localPort: 45678,
      process: process as unknown as ChildProcess,
      stderrTail: () => '',
      dispose,
      close
    }))
    const route = await resolveSshBrowserNetworkExecutionRoute(
      { executionHost, runtimeId: 'runtime-a', runtimeRevision: 1 },
      {
        connectionManager: { getConnection: () => connection },
        isCurrentAuthority: () => true,
        registerAuthorityAbort: () => () => {},
        startDynamicForward,
        readHostProxyEnvironment: noHostProxy
      }
    )

    expect(startDynamicForward).toHaveBeenCalledOnce()
    process.emit('error', new Error('dynamic forward failed'))
    await route.whenInvalidated
    expect(route.isValid()).toBe(false)
    await route.close()
    await route.close()
    expect(dispose).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('fails a stale system SSH socket loudly instead of closing it silently', async () => {
    const listener = createServer()
    servers.push(listener)
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const connection = fakeConnection(null)
    const forwardProcess = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
    }
    forwardProcess.exitCode = null
    forwardProcess.signalCode = null
    const route = await resolveSshBrowserNetworkExecutionRoute(
      { executionHost, runtimeId: 'runtime-a', runtimeRevision: 1 },
      {
        connectionManager: { getConnection: () => connection },
        isCurrentAuthority: () => true,
        registerAuthorityAbort: () => () => {},
        readHostProxyEnvironment: noHostProxy,
        startDynamicForward: async () => ({
          localPort: (listener.address() as AddressInfo).port,
          process: forwardProcess as unknown as ChildProcess,
          stderrTail: () => '',
          dispose: () => {},
          close: async () => {}
        })
      }
    )

    forwardProcess.exitCode = 0
    const socket = route.connect({ host: 'stale.internal', port: 443 })
    const events: string[] = []
    socket.on('error', (error) => events.push(`error:${error.message}`))
    socket.on('close', () => events.push('close'))

    await vi.waitFor(() => expect(events).toContain('close'))
    expect(events[0]).toBe('error:browser_tunnel_execution_host_stale')
    await route.close()
  })

  it('aborts system SSH startup when route authorization is revoked', async () => {
    const connection = fakeConnection(null)
    const controller = new AbortController()
    const removeAuthorityAbort = vi.fn()
    const startDynamicForward = vi.fn(
      async (_connection: SshConnection, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new Error('system_ssh_dynamic_forward_aborted')),
            { once: true }
          )
        )
    )
    const resolving = resolveSshBrowserNetworkExecutionRoute(
      {
        executionHost,
        runtimeId: 'runtime-a',
        runtimeRevision: 1,
        signal: controller.signal
      },
      {
        connectionManager: { getConnection: () => connection },
        isCurrentAuthority: () => true,
        registerAuthorityAbort: () => removeAuthorityAbort,
        startDynamicForward,
        readHostProxyEnvironment: noHostProxy
      }
    )
    await vi.waitFor(() => expect(startDynamicForward).toHaveBeenCalledOnce())

    controller.abort()

    await expect(resolving).rejects.toThrow('system_ssh_dynamic_forward_aborted')
    expect(removeAuthorityAbort).toHaveBeenCalledOnce()
  })
})

describe('SSH browser network execution route through the host proxy (#35217)', () => {
  const sandboxProxy = { host: 'proxy.sandbox.internal', port: 3128 }
  const hostProxyEnvironment = async (): Promise<Record<string, string>> => ({
    HTTPS_PROXY: `http://${sandboxProxy.host}:${sandboxProxy.port}`,
    NO_PROXY: 'intranet.test'
  })

  afterEach(() => setNetworkProxySettingsSource(null))

  async function listen(server: ReturnType<typeof createServer>): Promise<number> {
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    return typeof address === 'object' && address ? address.port : 0
  }

  // Stands in for the host: only loopback and the sandbox proxy are reachable from it.
  async function startHostNetwork(): Promise<{
    dial: (host: string, port: number) => Promise<Socket>
    proxyRequests: string[]
  }> {
    const echoPort = await listen(
      createServer((socket) =>
        socket.on('data', (bytes: Buffer) => socket.write(`echo:${bytes.toString()}`))
      )
    )
    const proxyRequests: string[] = []
    const proxyPort = await listen(
      createServer((client) => {
        client.once('data', (head) => {
          proxyRequests.push(/^CONNECT (\S+) /.exec(String(head))?.[1] ?? 'malformed')
          const upstream = connect(echoPort, '127.0.0.1', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            client.pipe(upstream).pipe(client)
          })
        })
      })
    )
    const dial = (host: string, port: number): Promise<Socket> =>
      new Promise((resolve, reject) => {
        const local =
          host === sandboxProxy.host && port === sandboxProxy.port
            ? proxyPort
            : host === 'localhost' || host === 'intranet.test'
              ? echoPort
              : null
        if (local === null) {
          reject(new Error('Connection refused'))
          return
        }
        const socket = connect(local, '127.0.0.1', () => resolve(socket))
        socket.once('error', reject)
      })
    return { dial, proxyRequests }
  }

  function roundTrip(socket: BrowserNetworkTunnelSocket, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      socket.on('error', reject)
      socket.on('connect', () => socket.write(Buffer.from(payload)))
      socket.on('data', (bytes) => {
        resolve(Buffer.from(bytes).toString())
        socket.destroy()
      })
    })
  }

  it('reaches external sites over ssh2 through the host proxy and keeps local names direct', async () => {
    const network = await startHostNetwork()
    const forwardOut = vi.fn(
      (
        _sourceHost: string,
        _sourcePort: number,
        host: string,
        port: number,
        callback: (error: Error | undefined, channel?: Socket) => void
      ) => {
        network.dial(host, port).then(
          (socket) => callback(undefined, socket),
          (error: Error) => callback(error)
        )
      }
    )
    const connection = fakeConnection({ forwardOut })
    // This machine's own proxy must not decide how the host leaves its network.
    setNetworkProxySettingsSource(() => ({ httpProxyUrl: 'http://127.0.0.1:1' }))
    const route = await resolveSshBrowserNetworkExecutionRoute(
      { executionHost, runtimeId: 'runtime-a', runtimeRevision: 1 },
      {
        connectionManager: { getConnection: () => connection },
        isCurrentAuthority: () => true,
        registerAuthorityAbort: () => () => {},
        readHostProxyEnvironment: hostProxyEnvironment
      }
    )

    await expect(roundTrip(route.connect({ host: 'example.com', port: 443 }), 'a')).resolves.toBe(
      'echo:a'
    )
    await expect(roundTrip(route.connect({ host: 'localhost', port: 8765 }), 'b')).resolves.toBe(
      'echo:b'
    )
    await expect(roundTrip(route.connect({ host: 'intranet.test', port: 80 }), 'c')).resolves.toBe(
      'echo:c'
    )
    expect(network.proxyRequests).toEqual(['example.com:443'])
    expect(forwardOut.mock.calls.map(([, , host, port]) => `${host}:${port}`)).toEqual([
      'proxy.sandbox.internal:3128',
      'localhost:8765',
      'intranet.test:80'
    ])
    await route.close()
  })

  it('dials directly while the host environment is unreadable and adopts it once a retry reads it', async () => {
    const network = await startHostNetwork()
    const forwardOut = vi.fn(
      (
        _sourceHost: string,
        _sourcePort: number,
        host: string,
        port: number,
        callback: (error: Error | undefined, channel?: Socket) => void
      ) => {
        network.dial(host, port).then(
          (socket) => callback(undefined, socket),
          (error: Error) => callback(error)
        )
      }
    )
    const readHostProxyEnvironment = vi
      .fn<() => Promise<Record<string, string>>>()
      .mockRejectedValueOnce(new Error('SSH exec timed out'))
      .mockImplementation(hostProxyEnvironment)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const connection = fakeConnection({ forwardOut })
    const route = await resolveSshBrowserNetworkExecutionRoute(
      { executionHost, runtimeId: 'runtime-a', runtimeRevision: 1 },
      {
        connectionManager: { getConnection: () => connection },
        isCurrentAuthority: () => true,
        registerAuthorityAbort: () => () => {},
        readHostProxyEnvironment
      }
    )

    await expect(roundTrip(route.connect({ host: 'example.com', port: 443 }), 'a')).rejects.toThrow(
      'Connection refused'
    )
    expect(readHostProxyEnvironment).toHaveBeenCalledOnce()
    now.mockReturnValue(16_000)
    route.connect({ host: 'localhost', port: 8765 }).destroy()
    expect(readHostProxyEnvironment).toHaveBeenCalledTimes(2)
    await readHostProxyEnvironment.mock.results[1]?.value
    await expect(roundTrip(route.connect({ host: 'example.com', port: 443 }), 'b')).resolves.toBe(
      'echo:b'
    )
    expect(network.proxyRequests).toEqual(['example.com:443'])
    expect(warn).toHaveBeenCalledOnce()
    await route.close()
    now.mockRestore()
    warn.mockRestore()
  })

  it('reaches external sites over system SSH through the host proxy', async () => {
    const network = await startHostNetwork()
    // Stands in for `ssh -D`, whose destinations are dialed by the host.
    const dynamicForward = new RemoteBrowserSocksServer({
      open: (target) => network.dial(target.host, target.port)
    })
    const { port: localPort } = await dynamicForward.listen()
    const forwardProcess = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
    }
    forwardProcess.exitCode = null
    forwardProcess.signalCode = null
    const connection = fakeConnection(null)
    const route = await resolveSshBrowserNetworkExecutionRoute(
      { executionHost, runtimeId: 'runtime-a', runtimeRevision: 1 },
      {
        connectionManager: { getConnection: () => connection },
        isCurrentAuthority: () => true,
        registerAuthorityAbort: () => () => {},
        readHostProxyEnvironment: hostProxyEnvironment,
        startDynamicForward: async () => ({
          localPort,
          process: forwardProcess as unknown as ChildProcess,
          stderrTail: () => '',
          dispose: () => {},
          close: async () => {}
        })
      }
    )

    await expect(roundTrip(route.connect({ host: 'example.com', port: 443 }), 'd')).resolves.toBe(
      'echo:d'
    )
    expect(network.proxyRequests).toEqual(['example.com:443'])
    await route.close()
    await dynamicForward.close()
  })
})
