import { EventEmitter, once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '../ssh/ssh-connection'
import type { SshProviderEpoch } from '../../shared/ssh-types'
import { resolveSshBrowserNetworkExecutionRoute } from './ssh-browser-network-execution-route'
import { SshConnectionWorkLedger } from '../ssh/ssh-connection-work-ledger'
import { forwardTrackedSshChannel } from '../ssh/ssh-forward-channel-lifetime'
import { openTrackedSshSocket } from '../ssh/ssh-connection-channel-lifetime'

const executionHost = {
  kind: 'ssh' as const,
  targetId: 'target-a',
  providerEpoch: 'provider-epoch-a',
  connectionGeneration: 2
}

function fakeConnection(client: unknown): SshConnection {
  const ledger = new SshConnectionWorkLedger()
  return {
    fenceWorkForReset: () => ledger.fenceForReset(),
    prepareForwardRoute: (prepare: () => Promise<unknown>) => ledger.run(prepare),
    openForwardSocket: (open: () => NodeJS.EventEmitter) => openTrackedSshSocket(ledger, open),
    forwardOut: ((expected, socket, ...args) =>
      forwardTrackedSshChannel(ledger, expected, socket, ...args)) as SshConnection['forwardOut'],
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

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

describe('SSH browser network execution route', () => {
  it('does not fall back to raw SSH when the selected session tunnel refuses admission', async () => {
    const forwardOut = vi.fn()
    const connection = fakeConnection({ forwardOut })
    const release = vi.fn()
    const openNetworkTunnel = vi.fn(async () => {
      throw new Error('relay_network_tunnel_capability_unavailable')
    })
    await expect(
      resolveSshBrowserNetworkExecutionRoute(
        { executionHost, runtimeId: 'runtime-a', runtimeRevision: 1 },
        {
          connectionManager: { getConnection: () => connection },
          isCurrentAuthority: () => true,
          registerAuthorityAbort: () => release,
          openNetworkTunnel
        }
      )
    ).rejects.toThrow('capability_unavailable')
    expect(openNetworkTunnel).toHaveBeenCalledOnce()
    expect(forwardOut).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('fences cached route opens while allowing an admitted channel to finish', async () => {
    const channel = new PassThrough() as PassThrough & { close: () => void }
    channel.close = () => {
      channel.destroy()
    }
    const forwardOut = vi.fn((_a, _b, _c, _d, callback) => callback(undefined, channel))
    const connection = fakeConnection({ forwardOut })
    const route = await resolveSshBrowserNetworkExecutionRoute(
      { executionHost, runtimeId: 'runtime-a', runtimeRevision: 1 },
      {
        connectionManager: { getConnection: () => connection },
        isCurrentAuthority: () => true,
        registerAuthorityAbort: () => () => {}
      }
    )
    const admitted = route.connect({ host: 'internal', port: 443 })
    await once(admitted as unknown as EventEmitter, 'connect')
    const fence = connection.fenceWorkForReset()
    expect(route.isValid()).toBe(true)
    const refused = route.connect({ host: 'internal', port: 443 })
    const [error] = await once(refused as unknown as EventEmitter, 'error')
    expect(error.message).toBe('ssh_connection_work_admission_closed')
    expect(forwardOut).toHaveBeenCalledTimes(1)
    expect(channel.destroyed).toBe(false)
    expect(() => fence.assertDrained()).toThrow('not_drained')
    channel.destroy()
    await fence.drain(new AbortController().signal)
    await route.close()
  })

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
        }
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
        registerAuthorityAbort: () => () => {}
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
        registerAuthorityAbort: () => () => {}
      }
    )
    const socket = route.connect({ host: 'remote-only.internal', port: 443 })
    socket.on('error', () => {})
    const close = vi.fn()
    socket.on('close', close)

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(socket.destroyed).toBe(true)
    await expect(route.close()).rejects.toThrow('Not connected')
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
    const stopped = Promise.withResolvers<void>()
    const close = vi.fn(() => stopped.promise)
    const release = vi.fn()
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
        registerAuthorityAbort: () => release,
        startDynamicForward
      }
    )

    expect(startDynamicForward).toHaveBeenCalledOnce()
    process.emit('error', new Error('dynamic forward failed'))
    await route.whenInvalidated
    expect(route.isValid()).toBe(false)
    const closing = route.close()
    expect(route.close()).toBe(closing)
    expect(release).not.toHaveBeenCalled()
    stopped.resolve()
    await closing
    expect(release).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('retains system route authority evidence after unconfirmed process closure', async () => {
    const connection = fakeConnection(null)
    const release = vi.fn()
    const close = vi.fn(async () => {
      throw new Error('stop unconfirmed')
    })
    const route = await resolveSshBrowserNetworkExecutionRoute(
      { executionHost, runtimeId: 'runtime-a', runtimeRevision: 1 },
      {
        connectionManager: { getConnection: () => connection },
        isCurrentAuthority: () => true,
        registerAuthorityAbort: () => release,
        startDynamicForward: async () => ({
          localPort: 45678,
          process: Object.assign(new EventEmitter(), {
            exitCode: null,
            signalCode: null
          }) as unknown as ChildProcess,
          stderrTail: () => '',
          dispose: () => {},
          close
        })
      }
    )
    const closing = route.close()
    await expect(closing).rejects.toThrow('stop unconfirmed')
    expect(route.close()).toBe(closing)
    expect(release).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('drains admitted system sockets and refuses cached route opens without another TCP connection', async () => {
    const accepted: Socket[] = []
    const listener = createServer((socket) => {
      accepted.push(socket)
      socket.once('data', () => {
        socket.write(Buffer.from([5, 0]))
        socket.once('data', () => socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])))
      })
    })
    servers.push(listener)
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const connection = fakeConnection(null)
    const process = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
    const dispose = vi.fn()
    const route = await resolveSshBrowserNetworkExecutionRoute(
      { executionHost, runtimeId: 'runtime-a', runtimeRevision: 1 },
      {
        connectionManager: { getConnection: () => connection },
        isCurrentAuthority: () => true,
        registerAuthorityAbort: () => () => {},
        startDynamicForward: async () => ({
          localPort: (listener.address() as AddressInfo).port,
          process: process as unknown as ChildProcess,
          stderrTail: () => '',
          dispose,
          close: async () => {}
        })
      }
    )
    const socket = route.connect({ host: 'internal', port: 443 })
    socket.on('error', () => {})
    try {
      await once(socket as unknown as EventEmitter, 'connect')
      const fence = connection.fenceWorkForReset()
      const refused = route.connect({ host: 'internal', port: 443 })
      const [error] = await once(refused as unknown as EventEmitter, 'error')
      expect(error.message).toBe('ssh_connection_work_admission_closed')
      expect(route.isValid()).toBe(true)
      expect(accepted).toHaveLength(1)
      expect(dispose).not.toHaveBeenCalled()
      socket.destroy()
      expect(() => fence.assertDrained()).toThrow('not_drained')
      await fence.drain(new AbortController().signal)
    } finally {
      socket.destroy()
      for (const peer of accepted) {
        peer.destroy()
      }
      await route.close()
    }
  })

  it('refuses system route startup after reset and releases its authority registration', async () => {
    const connection = fakeConnection(null)
    connection.fenceWorkForReset()
    const startDynamicForward = vi.fn()
    const release = vi.fn()
    await expect(
      resolveSshBrowserNetworkExecutionRoute(
        { executionHost, runtimeId: 'runtime-a', runtimeRevision: 1 },
        {
          connectionManager: { getConnection: () => connection },
          isCurrentAuthority: () => true,
          registerAuthorityAbort: () => release,
          startDynamicForward
        }
      )
    ).rejects.toThrow('admission_closed')
    expect(startDynamicForward).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
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

    // A bare close reaches the tunnel session as a pre-connect close, which fences the whole tunnel.
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
        startDynamicForward
      }
    )
    await vi.waitFor(() => expect(startDynamicForward).toHaveBeenCalledOnce())

    controller.abort()

    await expect(resolving).rejects.toThrow('system_ssh_dynamic_forward_aborted')
    expect(removeAuthorityAbort).toHaveBeenCalledOnce()
  })
})
