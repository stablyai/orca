import { Duplex, PassThrough, Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient, type DaemonClientTransport } from './client'
import { encodeNdjson, createNdjsonParser } from './ndjson'

const identity = { pid: 42, startedAtMs: 123, launchNonce: 'owner' }
const clients: DaemonClient[] = []
const streams: Duplex[] = []
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.disconnect()
  }
  for (const stream of streams.splice(0)) {
    stream.destroy()
  }
})
function pair() {
  const toServer = new PassThrough()
  const toClient = new PassThrough()
  const client = Duplex.from({
    readable: Readable.toWeb(toClient),
    writable: Writable.toWeb(toServer)
  })
  const server = Duplex.from({
    readable: Readable.toWeb(toServer),
    writable: Writable.toWeb(toClient)
  })
  streams.push(client, server)
  for (const stream of [client, server]) {
    stream.on('error', () => {})
  }
  return { client, server }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
function harness(
  otherIdentity = identity,
  admitIdentity?: (identity: typeof otherIdentity | null) => Promise<void>
) {
  const endpoints = new Map<string, ReturnType<typeof pair>>()
  const hellos: unknown[] = []
  const transport: DaemonClientTransport = {
    readToken: async () => 'token',
    connect: async (role) => {
      const endpoint = pair()
      endpoints.set(role, endpoint)
      const parser = createNdjsonParser(
        (message) => {
          if (!message || typeof message !== 'object' || !('type' in message)) {
            return
          }
          if (message.type === 'hello') {
            hellos.push(message)
            endpoint.server.write(
              encodeNdjson({
                ok: true,
                daemonIdentity: role === 'control' ? identity : otherIdentity
              })
            )
          } else if ('id' in message && typeof message.id === 'string') {
            endpoint.server.write(
              encodeNdjson({
                id: message.id,
                ok: true,
                payload: { echoed: 'payload' in message ? message.payload : undefined }
              })
            )
          }
        },
        () => {}
      )
      endpoint.server.on('data', (data: Buffer) => parser.feed(data.toString()))
      return endpoint.client
    }
  }
  const client = new DaemonClient({ transport, admitIdentity })
  clients.push(client)
  return { client, transport, endpoints, hellos }
}

describe('daemon ordered duplex transport', () => {
  it('does not publish a connection or its events before admission and fences a canceled admission', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    const admit = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { client, endpoints } = harness(identity, admit)
    const event = vi.fn()
    client.onEvent(event)
    const connecting = expect(client.ensureConnected()).rejects.toThrow('Disconnected')
    await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce())
    endpoints.get('stream')!.server.write(
      encodeNdjson({
        type: 'event',
        event: 'data',
        sessionId: 's',
        payload: { data: 'unadmitted' }
      })
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(event).not.toHaveBeenCalled()
    await expect(client.request('ping', undefined)).rejects.toThrow('Not connected')
    client.disconnect()
    first.resolve()
    await connecting
    const reconnected = client.ensureConnected()
    await vi.waitFor(() => expect(admit).toHaveBeenCalledTimes(2))
    await expect(client.request('ping', undefined)).rejects.toThrow('Not connected')
    second.resolve()
    await reconnected
    await expect(client.request('ping', undefined)).resolves.toEqual({})
    expect(event).not.toHaveBeenCalled()
  })

  it('authenticates both roles, handles RPC/events and settles notify writes', async () => {
    const { client, endpoints, hellos } = harness()
    const event = vi.fn()
    client.onEvent(event)
    await client.ensureConnected()
    expect(hellos).toEqual([
      expect.objectContaining({ role: 'control', token: 'token', clientId: expect.any(String) }),
      expect.objectContaining({ role: 'stream', token: 'token', clientId: expect.any(String) })
    ])
    expect(await client.request('echo', 'hello')).toEqual({ echoed: 'hello' })
    const payload = { type: 'event', event: 'output', data: '界' }
    endpoints.get('stream')!.server.write(encodeNdjson(payload))
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith(payload))
    expect(await client.notifyWithSettlement('input', 'x')).toEqual({ outcome: 'accepted' })
    expect(client.getDaemonIdentity()).toEqual(identity)
  })

  it('preserves an event coalesced with the stream hello reply', async () => {
    const event = vi.fn()
    const payload = { type: 'event', event: 'output', data: '界' }
    const transport: DaemonClientTransport = {
      readToken: () => 'token',
      connect: async (role) => {
        const endpoint = pair()
        endpoint.server.once('data', () =>
          endpoint.server.write(
            encodeNdjson({ ok: true, daemonIdentity: identity }) +
              (role === 'stream' ? encodeNdjson(payload) : '')
          )
        )
        return endpoint.client
      }
    }
    const client = new DaemonClient({ transport })
    clients.push(client)
    client.onEvent(event)
    await client.ensureConnected()
    await vi.waitFor(() => expect(event).toHaveBeenCalledExactlyOnceWith(payload))
  })

  it('refuses distinct owners on paired connections and destroys both', async () => {
    const { client, endpoints } = harness({ ...identity, launchNonce: 'other' })
    await expect(client.ensureConnected()).rejects.toThrow('identity changed')
    expect(client.isConnected()).toBe(false)
    expect([...endpoints.values()].every(({ client: stream }) => stream.destroyed)).toBe(true)
  })

  it('cancels an asynchronous token read without ever connecting', async () => {
    const token = deferred<string>()
    const connect = vi.fn()
    let signal: AbortSignal | undefined
    const client = new DaemonClient({
      transport: {
        readToken: (operation) => {
          signal = operation.signal
          return token.promise
        },
        connect
      }
    })
    clients.push(client)
    const pending = client.ensureConnected()
    const rejection = expect(pending).rejects.toThrow('Disconnected')
    await vi.waitFor(() => expect(signal).toBeDefined())
    client.disconnect()
    await rejection
    expect(signal?.aborted).toBe(true)
    token.resolve('late-token')
    await Promise.resolve()
    expect(connect).not.toHaveBeenCalled()
  })

  it('destroys a connection that arrives after cancellation', async () => {
    const connected = deferred<Duplex>()
    const connect = vi.fn(() => connected.promise)
    const client = new DaemonClient({ transport: { readToken: () => 'token', connect } })
    clients.push(client)
    const pending = client.ensureConnected()
    const rejection = expect(pending).rejects.toThrow('Disconnected')
    await vi.waitFor(() => expect(connect).toHaveBeenCalled())
    client.disconnect()
    await rejection
    const late = pair().client
    connected.resolve(late)
    await vi.waitFor(() => expect(late.destroyed).toBe(true))
  })

  it('closes authenticated control when stream connection fails', async () => {
    const { client, transport, endpoints } = harness()
    const connect = transport.connect
    transport.connect = (role, operation) =>
      role === 'stream' ? Promise.reject(new Error('bridge failed')) : connect(role, operation)
    await expect(client.ensureConnected()).rejects.toThrow('bridge failed')
    expect(endpoints.get('control')?.client.destroyed).toBe(true)
    expect(client.isConnected()).toBe(false)
  })

  it('aborts a pending stream bridge if authenticated control closes', async () => {
    const { client, transport, endpoints } = harness()
    const connect = transport.connect
    const pendingStream = deferred<Duplex>()
    transport.connect = (role, operation) =>
      role === 'stream' ? pendingStream.promise : connect(role, operation)
    const pending = client.ensureConnected()
    const rejection = expect(pending).rejects.toThrow('closed during setup')
    await vi.waitFor(() => expect(endpoints.get('control')).toBeDefined())
    endpoints.get('control')!.client.destroy()
    await rejection
    const late = pair().client
    pendingStream.resolve(late)
    await vi.waitFor(() => expect(late.destroyed).toBe(true))
  })

  it('waits for the writable callback under bridge backpressure', async () => {
    let releaseWrite: (() => void) | undefined
    const { client, transport } = harness()
    const connect = transport.connect
    transport.connect = async (role, operation) => {
      if (role !== 'control') {
        return connect(role, operation)
      }
      const stream = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          const message: unknown = JSON.parse(chunk.toString())
          if (
            message &&
            typeof message === 'object' &&
            'type' in message &&
            message.type === 'hello'
          ) {
            this.push(encodeNdjson({ ok: true, daemonIdentity: identity }))
            callback()
          } else {
            releaseWrite = () => callback()
          }
        }
      })
      streams.push(stream)
      return stream
    }
    await client.ensureConnected()
    let settled = false
    const write = client.notifyWithSettlement('input', 'x').then((value) => {
      settled = true
      return value
    })
    await vi.waitFor(() => expect(releaseWrite).toBeDefined())
    expect(settled).toBe(false)
    releaseWrite?.()
    await expect(write).resolves.toEqual({ outcome: 'accepted' })
  })

  it('bounds asynchronous token work by the shared connection deadline', async () => {
    const client = new DaemonClient({
      transport: { readToken: () => new Promise(() => {}), connect: vi.fn() }
    })
    clients.push(client)
    await expect(client.ensureConnectedWithin(15)).rejects.toThrow('timed out')
  })
})
