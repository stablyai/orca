import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupDaemonHandshake } from '../../relay/relay-handshake'
import { relayTestSocketPath } from '../../relay/relay-test-socket-path'
import {
  encodeFrame,
  encodeHandshakeFrame,
  encodeJsonRpcFrame,
  FrameDecoder,
  MessageType
} from '../../relay/protocol'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { connectOrcadLocalRelay, isOrcadLocalRelayEndpoint } from './orcad-local-relay-connection'
import { OrcadLocalRelayUnavailableError } from './orcad-local-relay-unavailable'

describe('host-local relay endpoint validation', () => {
  it.each([
    ['win32', String.raw`\\.\pipe\orca-relay-123`, true],
    ['win32', String.raw`\\?\pipe\orca-relay-123`, true],
    ['win32', String.raw`\\other-host\pipe\orca-relay-123`, false],
    ['win32', String.raw`\\other-host\share\relay.sock`, false],
    ['win32', String.raw`C:\relay.sock`, false],
    ['win32', '/tmp/relay.sock', false],
    ['linux', '/tmp/relay.sock', true],
    ['darwin', '/tmp/relay.sock', true],
    ['linux', 'relative.sock', false],
    ['linux', '/tmp/relay.sock\0other', false]
  ] as const)('validates %s endpoint %s', (platform, endpoint, allowed) => {
    expect(isOrcadLocalRelayEndpoint(endpoint, platform)).toBe(allowed)
  })
})

describe('host-local incumbent relay connection', () => {
  let directory: string
  let endpoint: string
  let server: Server | undefined
  const sockets = new Set<Socket>()
  const clients: SshChannelMultiplexer[] = []
  const initialize = (client: SshChannelMultiplexer): void => {
    clients.push(client)
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-local-relay-'))
    endpoint = relayTestSocketPath(directory)
  })
  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.dispose()
    }
    for (const socket of sockets) {
      socket.destroy()
    }
    sockets.clear()
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
    }
    server = undefined
    rmSync(directory, { recursive: true, force: true })
  })
  async function listen(accept: (socket: Socket) => void): Promise<void> {
    server = createServer((socket) => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.once('close', () => sockets.delete(socket))
      accept(socket)
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(endpoint, resolve)
    })
  }
  const connect = (patch: Partial<Parameters<typeof connectOrcadLocalRelay>[0]> = {}) =>
    connectOrcadLocalRelay({ endpoint, incumbentVersion: 'incumbent-build', initialize, ...patch })

  it('classifies a missing endpoint as transport unavailability without exposing a client', async () => {
    const exposed = vi.fn()
    await expect(connect({ initialize: exposed })).rejects.toBeInstanceOf(
      OrcadLocalRelayUnavailableError
    )
    expect(exposed).not.toHaveBeenCalled()
  })

  it('uses the existing authenticated handshake and framed RPC over a real socket', async () => {
    const accepted = vi.fn()
    await listen((socket) =>
      setupDaemonHandshake(socket, {
        launchVersion: 'incumbent-build',
        endpointCredential: 'endpoint-secret',
        onAccepted: (connection, leftover) => {
          accepted()
          const decoder = new FrameDecoder(
            (frame) => {
              if (frame.type !== MessageType.Regular) {
                return
              }
              const request = JSON.parse(frame.payload.toString())
              connection.write(
                encodeJsonRpcFrame(
                  { jsonrpc: '2.0', id: request.id, result: { method: request.method } },
                  1,
                  frame.id
                )
              )
            },
            () => connection.destroy()
          )
          connection.on('data', (chunk: Buffer) => decoder.feed(chunk))
          if (leftover.length) {
            decoder.feed(leftover)
          }
        }
      })
    )
    const client = await connect({ endpointCredential: 'endpoint-secret' })
    expect(await client.request('system.info', {})).toEqual({ method: 'system.info' })
    expect(accepted).toHaveBeenCalledOnce()
  })

  it('delivers coalesced post-handshake frames only after consumers are installed', async () => {
    await listen((socket) =>
      socket.once('data', () =>
        socket.write(
          Buffer.concat([
            encodeHandshakeFrame({ type: 'orca-relay-handshake-ok', version: 'incumbent-build' }),
            encodeJsonRpcFrame(
              { jsonrpc: '2.0', method: 'test.ready', params: { sequence: 1 } },
              1,
              0
            )
          ])
        )
      )
    )
    const notification = vi.fn()
    await connect({
      initialize: (client) => {
        initialize(client)
        client.onNotification(notification)
      }
    })
    expect(notification).toHaveBeenCalledWith('test.ready', { sequence: 1 })
  })

  it.each(['wrong-version', 'wrong-credential'] as const)(
    'refuses %s without exposing a client',
    async (failure) => {
      const accepted = vi.fn()
      const exposed = vi.fn()
      await listen((socket) =>
        setupDaemonHandshake(socket, {
          launchVersion: 'incumbent-build',
          endpointCredential: 'endpoint-secret',
          onAccepted: accepted
        })
      )
      const refusal = await connect({
        incumbentVersion: failure === 'wrong-version' ? 'new-build' : 'incumbent-build',
        endpointCredential: failure === 'wrong-credential' ? 'wrong' : 'endpoint-secret',
        initialize: exposed
      }).catch((error: unknown) => error)
      expect(refusal).toBeInstanceOf(Error)
      expect(refusal).not.toBeInstanceOf(OrcadLocalRelayUnavailableError)
      expect(accepted).not.toHaveBeenCalled()
      expect(exposed).not.toHaveBeenCalled()
    }
  )

  it('refuses a wrong-version success acknowledgement', async () => {
    await listen((socket) =>
      socket.once('data', () =>
        socket.write(
          encodeHandshakeFrame({ type: 'orca-relay-handshake-ok', version: 'wrong-build' })
        )
      )
    )
    await expect(connect()).rejects.toMatchObject({ exitCode: 42 })
  })

  it('bounds a silent handshake and closes only its socket', async () => {
    await listen((socket) => {
      socket.resume()
    })
    await expect(connect({ timeoutMs: 20 })).rejects.toThrow('orcad_local_relay_connect_timeout')
    await vi.waitFor(() => expect(sockets.size).toBe(0))
    expect(server!.listening).toBe(true)
  })

  it('cancels an in-flight handshake and cannot accept a late reply', async () => {
    const controller = new AbortController()
    const exposed = vi.fn()
    await listen((socket) => socket.once('data', () => controller.abort(new Error('cancelled'))))
    await expect(connect({ signal: controller.signal, initialize: exposed })).rejects.toThrow(
      'cancelled'
    )
    expect(exposed).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(sockets.size).toBe(0))
  })

  it('rejects initialization failure and cleans up the multiplexer', async () => {
    await listen((socket) =>
      setupDaemonHandshake(socket, {
        launchVersion: 'incumbent-build',
        onAccepted: () => {}
      })
    )
    await expect(
      connect({
        initialize: () => {
          throw new Error('consumer unavailable')
        }
      })
    ).rejects.toThrow('consumer unavailable')
    await vi.waitFor(() => expect(sockets.size).toBe(0))
  })

  it('reports a transport loss as an unverifiable request outcome', async () => {
    await listen((socket) =>
      setupDaemonHandshake(socket, {
        launchVersion: 'incumbent-build',
        onAccepted: () => socket.once('data', () => socket.destroy())
      })
    )
    const client = await connect()
    await expect(client.request('system.info', {})).rejects.toMatchObject({
      code: 'CONNECTION_LOST'
    })
  })

  it('does not connect when already cancelled or given a nonlocal endpoint', async () => {
    await expect(connect({ signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow(
      'cancelled'
    )
    await expect(connect({ endpoint: 'tcp://host:1234' })).rejects.toThrow(
      'orcad_local_relay_endpoint_invalid'
    )
  })

  it.each([
    encodeFrame(MessageType.Handshake, 0, 0, Buffer.from('{')),
    encodeFrame(MessageType.Handshake, 0, 0, Buffer.from('null')),
    encodeJsonRpcFrame({ jsonrpc: '2.0', method: 'unexpected' }, 1, 0),
    encodeHandshakeFrame({ type: 'orca-relay-handshake', version: 'incumbent-build' })
  ])('rejects malformed or out-of-order handshake reply %#', async (reply) => {
    const exposed = vi.fn()
    await listen((socket) => socket.once('data', () => socket.write(reply)))
    await expect(connect({ initialize: exposed })).rejects.toMatchObject({ exitCode: 1 })
    expect(exposed).not.toHaveBeenCalled()
  })

  it('accepts a fragmented handshake frame', async () => {
    const frame = encodeHandshakeFrame({
      type: 'orca-relay-handshake-ok',
      version: 'incumbent-build'
    })
    await listen((socket) =>
      socket.once('data', () => {
        socket.write(frame.subarray(0, 7))
        setImmediate(() => socket.write(frame.subarray(7)))
      })
    )
    await expect(connect()).resolves.toBeDefined()
  })

  it('rejects a handshake socket closed before acknowledgement', async () => {
    await listen((socket) => socket.once('data', () => socket.destroy()))
    await expect(connect()).rejects.toThrow('orcad_local_relay_connection_closed')
  })

  it('does not return a multiplexer disposed during initialization', async () => {
    await listen((socket) =>
      setupDaemonHandshake(socket, {
        launchVersion: 'incumbent-build',
        onAccepted: () => {}
      })
    )
    await expect(connect({ initialize: (client) => client.dispose() })).rejects.toThrow(
      'orcad_local_relay_connection_closed'
    )
  })
})
