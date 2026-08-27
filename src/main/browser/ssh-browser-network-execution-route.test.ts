import { EventEmitter, once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { createServer, type AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '../ssh/ssh-connection'
import type { SshProviderEpoch } from '../../shared/ssh-types'
import { resolveSshBrowserNetworkExecutionRoute } from './ssh-browser-network-execution-route'

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
        startDynamicForward
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
