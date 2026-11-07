import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import type { Endpoint } from '@number0/iroh'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeLengthPrefixedFrame } from './iroh-frame-codec'
import { IROH_ENDPOINT_SECRET_FILENAME } from './iroh-endpoint-secret'
import { IrohModuleLoadError } from './iroh-endpoint-bind'
import { IrohTransport } from './iroh-transport'
import { createFakeBind, FakeRecv, FakeSend } from './iroh-transport.test-fixture'

const native = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('./iroh-native-loader', () => ({ loadIrohNativeModule: native.load }))

describe('IrohTransport', () => {
  const dirs: string[] = []
  const transports: IrohTransport[] = []

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((t) => t.stop().catch(() => {})))
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
    native.load.mockReset()
    vi.useRealTimers()
  })

  it('starts with an injected bind and exposes endpointId without loading native iroh', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const recv = new FakeRecv()
    const send = new FakeSend()
    const fake = createFakeBind(recv, send)
    const transport = new IrohTransport({
      userDataPath,
      bindEndpoint: fake.bindEndpoint
    })
    transports.push(transport)

    await transport.start()
    expect(transport.endpointId).toBe(fake.endpointId)
  })

  it('rejects invalid relay preferences before creating identity or binding', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const relayUrl = 'https://user:secret@relay.example/'
    const fake = createFakeBind(new FakeRecv(), new FakeSend())
    const transport = new IrohTransport({
      userDataPath,
      relayUrl,
      bindEndpoint: fake.bindEndpoint
    })
    transports.push(transport)

    const error = await transport.start().catch((error: unknown) => error)

    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(relayUrl)
    expect(String(error)).not.toContain('secret')
    expect(fake.bindEndpoint).not.toHaveBeenCalled()
    expect(transport.endpointId).toBeNull()
    expect(transport.endpointDialHints()).toBeNull()
    expect(existsSync(join(userDataPath, IROH_ENDPOINT_SECRET_FILENAME))).toBe(false)
  })

  it('delivers length-prefixed text frames to the message handler', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const recv = new FakeRecv()
    const send = new FakeSend()
    const fake = createFakeBind(recv, send)
    const transport = new IrohTransport({
      userDataPath,
      preAuthTimeoutMs: 60_000,
      idleTimeoutMs: 60_000,
      bindEndpoint: fake.bindEndpoint
    })
    transports.push(transport)

    const received: string[] = []
    transport.onMessage((msg) => {
      if (typeof msg === 'string') {
        received.push(msg)
      }
    })
    await transport.start()
    fake.pushIncoming()

    const hello = '{"type":"e2ee_hello","publicKeyB64":"x"}'
    const frame = encodeLengthPrefixedFrame(new TextEncoder().encode(hello))
    recv.push(Array.from(frame))

    await vi.waitFor(() => {
      expect(received).toEqual([hello])
    })
  })

  it('keeps the pre-auth deadline fixed despite inbound frames from an unauthenticated peer', async () => {
    vi.useFakeTimers()
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const recv = new FakeRecv()
    const fake = createFakeBind(recv, new FakeSend())
    const transport = new IrohTransport({
      userDataPath,
      preAuthTimeoutMs: 1_000,
      idleTimeoutMs: 5_000,
      bindEndpoint: fake.bindEndpoint
    })
    transports.push(transport)
    const received = vi.fn()
    const closed = vi.fn()
    transport.onMessage(received)
    transport.onConnectionClose(closed)
    await transport.start()
    fake.pushIncoming()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.connection.acceptBi).toHaveBeenCalledOnce()

    for (let i = 0; i < 2; i += 1) {
      await vi.advanceTimersByTimeAsync(400)
      recv.push(
        Array.from(encodeLengthPrefixedFrame(new TextEncoder().encode('not authenticated')))
      )
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(received).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(199)
    expect(fake.connection.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.connection.close).toHaveBeenCalledOnce()
    expect(closed).toHaveBeenCalledWith(null, expect.anything(), false)
  })

  it('clears pre-auth on authentication and resets the idle deadline on complete inbound frames', async () => {
    vi.useFakeTimers()
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const recv = new FakeRecv()
    const fake = createFakeBind(recv, new FakeSend())
    const transport = new IrohTransport({
      userDataPath,
      preAuthTimeoutMs: 1_000,
      idleTimeoutMs: 2_000,
      bindEndpoint: fake.bindEndpoint
    })
    transports.push(transport)
    const received = vi.fn()
    const closed = vi.fn()
    transport.onMessage((message, _reply, socket) => {
      transport.setClientId(socket, 'mobile-client')
      received(message)
    })
    transport.onConnectionClose(closed)
    await transport.start()
    fake.pushIncoming()
    recv.push(Array.from(encodeLengthPrefixedFrame(new TextEncoder().encode('authenticate'))))
    await vi.advanceTimersByTimeAsync(0)
    expect(received).toHaveBeenCalledWith('authenticate')

    await vi.advanceTimersByTimeAsync(1_500)
    expect(fake.connection.close).not.toHaveBeenCalled()
    recv.push(Array.from(encodeLengthPrefixedFrame(new TextEncoder().encode('still active'))))
    await vi.advanceTimersByTimeAsync(0)
    expect(received).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fake.connection.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.connection.close).toHaveBeenCalledOnce()
    expect(closed).toHaveBeenCalledWith('mobile-client', expect.anything(), false)
  })

  it('marks an SDK import failure as a permanent module load failure', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    native.load.mockImplementation(() => {
      throw new Error('Native SDK unavailable')
    })
    const transport = new IrohTransport({ userDataPath })
    transports.push(transport)

    await expect(transport.start()).rejects.toBeInstanceOf(IrohModuleLoadError)
    expect(transport.endpointId).toBeNull()
    expect(transport.endpointDialHints()).toBeNull()
  })

  it('marks incompatible SDK exports as a permanent module load failure', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    native.load.mockReturnValue({
      Endpoint: { bind: null },
      RelayMode: { customFromUrls: null },
      Accepting: { incomingHandshakeTimeoutMs: () => 10_000 }
    })
    const transport = new IrohTransport({ userDataPath })
    transports.push(transport)

    await expect(transport.start()).rejects.toMatchObject({
      name: 'IrohModuleLoadError',
      reason: 'unsupported-api'
    })
    expect(transport.endpointId).toBeNull()
    expect(transport.endpointDialHints()).toBeNull()
  })

  it.each([
    undefined,
    {},
    { incomingHandshakeTimeoutMs: () => 30_000 },
    { incomingHandshakeTimeoutMs: () => '10000' },
    {
      incomingHandshakeTimeoutMs: () => {
        throw new Error('private-native-path')
      }
    }
  ])('rejects stock or unproven native SDKs before binding (%s)', async (Accepting) => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const bind = vi.fn()
    native.load.mockReturnValue({
      Endpoint: { bind },
      RelayMode: { customFromUrls: vi.fn() },
      Accepting,
      // A JS/default wrapper must not supply the missing native capability.
      default: { Accepting: { incomingHandshakeTimeoutMs: () => 10_000 } }
    })
    const transport = new IrohTransport({ userDataPath })
    transports.push(transport)

    const failure = await transport.start().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(IrohModuleLoadError)
    expect(failure).toMatchObject({ reason: 'unsupported-api' })
    expect(String(failure)).toContain('pnpm build:orcad-prebuilds')
    expect(String(failure)).not.toContain('private-native-path')
    expect(failure).not.toHaveProperty('cause')
    expect(bind).not.toHaveBeenCalled()
    expect(transport.endpointId).toBeNull()
  })

  it('does not classify a native socket bind failure as a permanent module load failure', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const cause = new Error('Socket temporarily unavailable')
    native.load.mockReturnValue({
      Endpoint: {
        bind: async () => {
          throw cause
        }
      },
      RelayMode: { customFromUrls: (urls: string[]) => ({ urls }) },
      Accepting: { incomingHandshakeTimeoutMs: () => 10_000 }
    })
    const transport = new IrohTransport({ userDataPath })
    transports.push(transport)

    await expect(transport.start()).rejects.toBe(cause)
    expect(transport.endpointId).toBeNull()
    expect(transport.endpointDialHints()).toBeNull()
  })

  it('keeps an explicit relay online failure failed without trying Automatic', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const fake = createFakeBind(new FakeRecv(), new FakeSend())
    const onlineFailure = new Error('relay unreachable')
    const bind = vi.fn(async (_options: unknown, relayMode?: { urls: string[] }) => {
      if (relayMode) {
        fake.endpoint.online.mockRejectedValue(onlineFailure)
      }
      return fake.endpoint
    })
    native.load.mockReturnValue({
      RelayMode: { customFromUrls: (urls: string[]) => ({ urls }) },
      Endpoint: { bind },
      Accepting: { incomingHandshakeTimeoutMs: () => 10_000 }
    })
    const transport = new IrohTransport({
      userDataPath,
      relayUrl: 'https://unreachable.relay.example/'
    })
    transports.push(transport)

    await expect(transport.start()).rejects.toBe(onlineFailure)
    await expect(transport.start()).rejects.toBe(onlineFailure)
    expect(fake.endpoint.close).toHaveBeenCalledOnce()
    expect(bind).toHaveBeenCalledOnce()
    expect(transport.endpointId).toBeNull()
    expect(transport.endpointDialHints()).toBeNull()
    expect(fake.endpoint.acceptNext).not.toHaveBeenCalled()
  })

  it('closes accepted connections whose bi-stream open fails', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const recv = new FakeRecv()
    const send = new FakeSend()
    const fake = createFakeBind(recv, send)
    // Why: without a socket the pre-auth reaper can't see this connection —
    // the accept path itself must close it.
    fake.connection.acceptBi.mockRejectedValue(new Error('open failed'))
    const transport = new IrohTransport({
      userDataPath,
      bindEndpoint: fake.bindEndpoint
    })
    transports.push(transport)
    await transport.start()
    fake.pushIncoming()

    await vi.waitFor(() => {
      expect(fake.connection.close).toHaveBeenCalledWith(0n, [])
    })
  })

  it('rejects a pre-authentication frame above 1 MiB before reading its payload', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const recv = new FakeRecv()
    const send = new FakeSend()
    const fake = createFakeBind(recv, send)
    const transport = new IrohTransport({
      userDataPath,
      preAuthTimeoutMs: 60_000,
      idleTimeoutMs: 60_000,
      bindEndpoint: fake.bindEndpoint
    })
    transports.push(transport)
    await transport.start()
    fake.pushIncoming()

    const header = Buffer.alloc(4)
    header.writeUInt32BE(1_048_577, 0)
    recv.push(Array.from(header))

    await vi.waitFor(() => {
      expect(fake.connection.close).toHaveBeenCalled()
    })
  })

  it.each([null, '  https://Selected.Relay.Example  '])(
    'publishes actual online hints and carries frames through the selected SDK route (%s)',
    async (relayUrl) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
      dirs.push(userDataPath)
      const recv = new FakeRecv()
      const fake = createFakeBind(recv, new FakeSend())
      const online = Promise.withResolvers<void>()
      const customRoute = relayUrl !== null
      fake.endpoint.online.mockImplementation(() => online.promise)
      native.load.mockReturnValue({
        RelayMode: { customFromUrls: (urls: string[]) => ({ urls }) },
        Accepting: { incomingHandshakeTimeoutMs: () => 10_000 },
        Endpoint: {
          bind: async (_options: unknown, mode?: { urls: string[] }) => {
            if (
              customRoute ? mode?.urls[0] !== 'https://selected.relay.example/' : mode !== undefined
            ) {
              throw new Error('selected route unavailable')
            }
            return fake.endpoint
          }
        }
      })
      const transport = new IrohTransport({ userDataPath, relayUrl })
      transports.push(transport)
      const received = vi.fn()
      transport.onMessage(received)

      const startup = transport.start()
      await vi.waitFor(() => expect(fake.endpoint.online).toHaveBeenCalledOnce())
      expect(transport.endpointId).toBeNull()
      expect(transport.endpointDialHints()).toBeNull()
      online.resolve()
      await startup
      expect(transport.endpointDialHints()).toEqual({
        relayUrl: 'https://actual.relay.example/',
        directAddresses: ['192.168.1.2:1234', '[::1]:1234']
      })
      fake.pushIncoming()
      recv.push(Array.from(encodeLengthPrefixedFrame(new TextEncoder().encode('routed'))))
      await vi.waitFor(() => expect(received.mock.calls[0]?.[0]).toBe('routed'))
      await transport.stop()
      expect(fake.connection.close).toHaveBeenCalledWith(0n, [])
      expect(transport.endpointDialHints()).toBeNull()
    }
  )

  it('does not bind or create identity when a fresh transport is stopped before start', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const fake = createFakeBind(new FakeRecv(), new FakeSend())
    const transport = new IrohTransport({ userDataPath, bindEndpoint: fake.bindEndpoint })
    transports.push(transport)

    await transport.stop()
    await transport.start()
    expect(fake.bindEndpoint).not.toHaveBeenCalled()
    expect(existsSync(join(userDataPath, IROH_ENDPOINT_SECRET_FILENAME))).toBe(false)
    expect(transport.endpointId).toBeNull()
    expect(transport.endpointDialHints()).toBeNull()
  })

  it('settles concurrent startup on stop during bind and closes the late endpoint', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const fake = createFakeBind(new FakeRecv(), new FakeSend())
    const binding = Promise.withResolvers<typeof fake.bound>()
    fake.bindEndpoint.mockImplementation(() => binding.promise)
    const transport = new IrohTransport({ userDataPath, bindEndpoint: fake.bindEndpoint })
    transports.push(transport)

    const startup = transport.start()
    const concurrentStartup = transport.start()
    expect(fake.bindEndpoint).toHaveBeenCalledOnce()
    await transport.stop()
    await Promise.all([startup, concurrentStartup])
    expect(fake.endpoint.close).not.toHaveBeenCalled()
    binding.resolve(fake.bound)
    await vi.waitFor(() => expect(fake.endpoint.close).toHaveBeenCalledOnce())
    expect(fake.endpoint.online).not.toHaveBeenCalled()
    expect(fake.endpoint.acceptNext).not.toHaveBeenCalled()
    expect(transport.endpointId).toBeNull()
    expect(transport.endpointDialHints()).toBeNull()
    await transport.start()
    expect(fake.bindEndpoint).toHaveBeenCalledOnce()
  })

  it.each(['resolve', 'reject'] as const)(
    'owns and closes a pending-online endpoint before its late %s',
    async (completion) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
      dirs.push(userDataPath)
      const fake = createFakeBind(new FakeRecv(), new FakeSend())
      const online = Promise.withResolvers<void>()
      fake.endpoint.online.mockImplementation(() => online.promise)
      const transport = new IrohTransport({ userDataPath, bindEndpoint: fake.bindEndpoint })
      transports.push(transport)

      const startup = transport.start()
      await vi.waitFor(() => expect(fake.endpoint.online).toHaveBeenCalledOnce())
      expect(transport.endpointDialHints()).toBeNull()
      await transport.stop()
      await startup
      expect(fake.endpoint.close).toHaveBeenCalledOnce()
      if (completion === 'resolve') {
        online.resolve()
      } else {
        online.reject(new Error('closed while coming online'))
      }
      await setImmediate()
      expect(fake.endpoint.acceptNext).not.toHaveBeenCalled()
      expect(transport.endpointId).toBeNull()
      expect(transport.endpointDialHints()).toBeNull()
    }
  )

  it('retains a bind failure and can stop after it', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const fake = createFakeBind(new FakeRecv(), new FakeSend())
    const failure = new Error('bind failed')
    fake.bindEndpoint.mockRejectedValue(failure)
    const transport = new IrohTransport({ userDataPath, bindEndpoint: fake.bindEndpoint })
    transports.push(transport)

    await expect(transport.start()).rejects.toBe(failure)
    await expect(transport.start()).rejects.toBe(failure)
    await transport.stop()
    expect(fake.bindEndpoint).toHaveBeenCalledOnce()
    expect(fake.endpoint.close).not.toHaveBeenCalled()
    expect(transport.endpointId).toBeNull()
    expect(transport.endpointDialHints()).toBeNull()
  })

  it('ignores a late bind rejection after cancellation', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const fake = createFakeBind(new FakeRecv(), new FakeSend())
    const binding = Promise.withResolvers<typeof fake.bound>()
    fake.bindEndpoint.mockImplementation(() => binding.promise)
    const transport = new IrohTransport({ userDataPath, bindEndpoint: fake.bindEndpoint })
    transports.push(transport)

    const startup = transport.start()
    await transport.stop()
    await startup
    binding.reject(new Error('bind failed after stop'))
    await setImmediate()
    expect(fake.endpoint.online).not.toHaveBeenCalled()
    expect(transport.endpointId).toBeNull()
  })

  it('refuses an incoming connection returned by acceptNext after stop', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const fake = createFakeBind(new FakeRecv(), new FakeSend())
    fake.endpoint.close.mockImplementation(async () => {})
    const transport = new IrohTransport({ userDataPath, bindEndpoint: fake.bindEndpoint })
    transports.push(transport)
    await transport.start()

    await transport.stop()
    fake.pushIncoming()
    await vi.waitFor(() => expect(fake.incoming.refuse).toHaveBeenCalledOnce())
    expect(fake.incoming.accept).not.toHaveBeenCalled()
    expect(fake.accepting.connect).not.toHaveBeenCalled()
  })

  it.each(['accept', 'connect'] as const)(
    'closes a connection completed after stop during incoming.%s',
    async (stage) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
      dirs.push(userDataPath)
      const recv = new FakeRecv()
      const read = vi.spyOn(recv, 'read')
      const fake = createFakeBind(recv, new FakeSend())
      const accepting = Promise.withResolvers<typeof fake.accepting>()
      const connecting = Promise.withResolvers<typeof fake.connection>()
      if (stage === 'accept') {
        fake.incoming.accept.mockImplementation(() => accepting.promise)
      } else {
        fake.accepting.connect.mockImplementation(() => connecting.promise)
      }
      const transport = new IrohTransport({ userDataPath, bindEndpoint: fake.bindEndpoint })
      transports.push(transport)
      await transport.start()
      fake.pushIncoming()
      await vi.waitFor(() =>
        expect(
          stage === 'accept' ? fake.incoming.accept : fake.accepting.connect
        ).toHaveBeenCalledOnce()
      )

      await transport.stop()
      if (stage === 'accept') {
        accepting.resolve(fake.accepting)
      } else {
        connecting.resolve(fake.connection)
      }
      await vi.waitFor(() => expect(fake.connection.close).toHaveBeenCalledWith(0n, []))
      expect(fake.connection.acceptBi).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
    }
  )

  it.each(['accept', 'connect', 'acceptBi'] as const)(
    'caps pending incoming.%s calls and concurrent sockets at 128, then reuses a freed slot',
    async (stage) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
      dirs.push(userDataPath)
      const peers = Array.from({ length: 129 }, () => {
        const fake = createFakeBind(new FakeRecv(), new FakeSend())
        const ready = Promise.withResolvers<void>()
        if (stage === 'accept') {
          fake.incoming.accept.mockImplementation(async () => {
            await ready.promise
            return fake.accepting
          })
        } else if (stage === 'connect') {
          fake.accepting.connect.mockImplementation(async () => {
            await ready.promise
            return fake.connection
          })
        } else {
          fake.connection.acceptBi.mockImplementation(async () => {
            await ready.promise
            return fake.bi
          })
        }
        fake.bi.recv.push(
          Array.from(encodeLengthPrefixedFrame(new TextEncoder().encode('accepted')))
        )
        return { fake, ready }
      })
      const endpoint = peers[0].fake
      const transport = new IrohTransport({
        userDataPath,
        preAuthTimeoutMs: 60_000,
        idleTimeoutMs: 60_000,
        bindEndpoint: endpoint.bindEndpoint
      })
      transports.push(transport)
      const received = vi.fn()
      transport.onMessage(received)
      await transport.start()
      for (const { fake } of peers) {
        endpoint.pushIncoming(fake.incoming)
        await setImmediate()
      }

      const overflow = peers[128].fake
      expect(overflow.incoming.refuse).toHaveBeenCalledOnce()
      expect(overflow.incoming.accept).not.toHaveBeenCalled()
      for (const { fake } of peers.slice(0, 128)) {
        const stalled =
          stage === 'accept'
            ? fake.incoming.accept
            : stage === 'connect'
              ? fake.accepting.connect
              : fake.connection.acceptBi
        expect(stalled).toHaveBeenCalledOnce()
      }
      expect(received).not.toHaveBeenCalled()

      // A handed-off socket must occupy the slot its pending accept reserved.
      peers[0].ready.resolve()
      await setImmediate()
      expect(received).toHaveBeenCalledOnce()
      endpoint.pushIncoming(overflow.incoming)
      await setImmediate()
      expect(overflow.incoming.refuse).toHaveBeenCalledTimes(2)

      for (const { ready } of peers) {
        ready.resolve()
      }
      await setImmediate()
      expect(received).toHaveBeenCalledTimes(128)
      endpoint.pushIncoming(overflow.incoming)
      await setImmediate()
      expect(overflow.incoming.refuse).toHaveBeenCalledTimes(3)
      expect(overflow.incoming.accept).not.toHaveBeenCalled()
      expect(overflow.connection.acceptBi).not.toHaveBeenCalled()
      expect(received).toHaveBeenCalledTimes(128)

      peers[0].fake.bi.recv.end()
      await setImmediate()
      expect(peers[0].fake.connection.close).toHaveBeenCalledOnce()
      endpoint.pushIncoming(overflow.incoming)
      await setImmediate()
      expect(overflow.incoming.accept).toHaveBeenCalledOnce()
      expect(received).toHaveBeenCalledTimes(129)
    }
  )

  it('closes an owned connection while acceptBi is pending and never publishes its late stream', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const recv = new FakeRecv()
    const read = vi.spyOn(recv, 'read')
    const fake = createFakeBind(recv, new FakeSend())
    const stream = Promise.withResolvers<typeof fake.bi>()
    fake.connection.acceptBi.mockImplementation(() => stream.promise)
    const transport = new IrohTransport({ userDataPath, bindEndpoint: fake.bindEndpoint })
    transports.push(transport)
    const received = vi.fn()
    transport.onMessage(received)
    await transport.start()
    fake.pushIncoming()
    await vi.waitFor(() => expect(fake.connection.acceptBi).toHaveBeenCalledOnce())

    await transport.stop()
    expect(fake.connection.close).toHaveBeenCalledWith(0n, [])
    stream.resolve(fake.bi)
    recv.push(Array.from(encodeLengthPrefixedFrame(new TextEncoder().encode('late'))))
    await setImmediate()
    expect(read).not.toHaveBeenCalled()
    expect(received).not.toHaveBeenCalled()
  })

  it('does not deliver a read completed after stop', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const recv = new FakeRecv()
    const read = vi.spyOn(recv, 'read')
    const fake = createFakeBind(recv, new FakeSend())
    const transport = new IrohTransport({ userDataPath, bindEndpoint: fake.bindEndpoint })
    transports.push(transport)
    const received = vi.fn()
    transport.onMessage(received)
    await transport.start()
    fake.pushIncoming()
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())

    await transport.stop()
    recv.push(Array.from(encodeLengthPrefixedFrame(new TextEncoder().encode('late'))))
    await setImmediate()
    expect(received).not.toHaveBeenCalled()
    expect(fake.connection.close).toHaveBeenCalledWith(0n, [])
  })

  it('closes a connection whose bi-stream times out without publishing a late stream', async () => {
    vi.useFakeTimers()
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const recv = new FakeRecv()
    const read = vi.spyOn(recv, 'read')
    const fake = createFakeBind(recv, new FakeSend())
    const stream = Promise.withResolvers<typeof fake.bi>()
    fake.connection.acceptBi.mockImplementation(() => stream.promise)
    const transport = new IrohTransport({ userDataPath, bindEndpoint: fake.bindEndpoint })
    transports.push(transport)
    await transport.start()
    fake.pushIncoming()
    await vi.waitFor(() => expect(fake.connection.acceptBi).toHaveBeenCalledOnce())

    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.connection.close).toHaveBeenCalledWith(0n, [])
    stream.resolve(fake.bi)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).not.toHaveBeenCalled()
  })

  it('stops decoding the current chunk when its first frame stops the transport', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const recv = new FakeRecv()
    const fake = createFakeBind(recv, new FakeSend())
    const transport = new IrohTransport({ userDataPath, bindEndpoint: fake.bindEndpoint })
    transports.push(transport)
    const received: string[] = []
    transport.onMessage((message) => {
      received.push(String(message))
      void transport.stop()
    })
    await transport.start()
    fake.pushIncoming()
    recv.push(
      Array.from(
        Buffer.concat([
          encodeLengthPrefixedFrame(new TextEncoder().encode('first')),
          encodeLengthPrefixedFrame(new TextEncoder().encode('second'))
        ])
      )
    )

    await vi.waitFor(() => expect(fake.connection.close).toHaveBeenCalled())
    expect(received).toEqual(['first'])
  })

  it('settles startup while a native bind is pending and closes its late result', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const fake = createFakeBind(new FakeRecv(), new FakeSend())
    const binding = Promise.withResolvers<Endpoint>()
    const bind = vi.fn(() => binding.promise)
    native.load.mockReturnValue({
      RelayMode: { customFromUrls: (urls: string[]) => ({ urls }) },
      Endpoint: { bind },
      Accepting: { incomingHandshakeTimeoutMs: () => 10_000 }
    })
    const transport = new IrohTransport({ userDataPath })
    transports.push(transport)

    const startup = transport.start()
    await vi.waitFor(() => expect(bind).toHaveBeenCalledOnce())
    await transport.stop()
    await startup
    binding.resolve(fake.bound.endpoint)
    await vi.waitFor(() => expect(fake.endpoint.close).toHaveBeenCalledOnce())
    expect(fake.endpoint.online).not.toHaveBeenCalled()
    expect(fake.endpoint.acceptNext).not.toHaveBeenCalled()
    expect(transport.endpointId).toBeNull()
    expect(transport.endpointDialHints()).toBeNull()
  })

  it.each(['accept', 'connect'] as const)(
    'keeps accepting after an incoming.%s failure',
    async (stage) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
      dirs.push(userDataPath)
      const recv = new FakeRecv()
      const fake = createFakeBind(recv, new FakeSend())
      const failure = new Error('handshake failed')
      if (stage === 'accept') {
        fake.incoming.accept.mockRejectedValueOnce(failure)
      } else {
        fake.accepting.connect.mockRejectedValueOnce(failure)
      }
      const transport = new IrohTransport({ userDataPath, bindEndpoint: fake.bindEndpoint })
      transports.push(transport)
      const received = vi.fn()
      transport.onMessage(received)
      await transport.start()
      fake.pushIncoming()
      await vi.waitFor(() =>
        expect(
          stage === 'accept' ? fake.incoming.accept : fake.accepting.connect
        ).toHaveBeenCalledOnce()
      )

      fake.pushIncoming()
      recv.push(Array.from(encodeLengthPrefixedFrame(new TextEncoder().encode('next peer'))))
      await vi.waitFor(() => expect(received.mock.calls[0]?.[0]).toBe('next peer'))
      expect(fake.endpoint.close).not.toHaveBeenCalled()
    }
  )

  it('joins the same owned endpoint close across repeated stop calls', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const fake = createFakeBind(new FakeRecv(), new FakeSend())
    const closed = Promise.withResolvers<void>()
    fake.endpoint.close.mockImplementation(() => closed.promise)
    const transport = new IrohTransport({ userDataPath, bindEndpoint: fake.bindEndpoint })
    transports.push(transport)
    await transport.start()

    const firstStop = transport.stop()
    const secondStop = transport.stop()
    const settled = vi.fn()
    void secondStop.then(settled)
    try {
      expect(secondStop).toBe(firstStop)
      expect(fake.endpoint.close).toHaveBeenCalledOnce()
      expect(transport.endpointId).toBeNull()
      expect(transport.endpointDialHints()).toBeNull()
      await setImmediate()
      expect(settled).not.toHaveBeenCalled()
    } finally {
      closed.resolve()
      await Promise.all([firstStop, secondStop])
    }
    expect(settled).toHaveBeenCalledOnce()
    expect(transport.stop()).toBe(firstStop)
    expect(fake.endpoint.close).toHaveBeenCalledOnce()
  })
})
