import { EventEmitter } from 'node:events'
import { createServer, connect, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelFrame,
  decodeBrowserNetworkTunnelWindowUpdate,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelOpen,
  encodeBrowserNetworkTunnelWindowUpdate,
  type BrowserNetworkTunnelFrame
} from '../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import { BrowserNetworkTunnelClient } from '../browser/network/tunnels/browser-network-tunnel-client'
import { BrowserNetworkTunnelSession } from '../browser/network/tunnels/browser-network-tunnel-session'
import {
  BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS,
  BROWSER_NETWORK_TUNNEL_EARLY_DATA_BYTES,
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
  type BrowserNetworkTunnelSocket
} from '../browser/network/tunnels/browser-network-tunnel-stream-state'
import { createPortForwardDialer } from '../runtime/rpc/methods/workspace-ports/workspace-port-forward-tunnel'
import { RuntimePortForwardManager } from './runtime-port-forward-manager'
import {
  EnvironmentPortForwardTunnel,
  type PortForwardTunnelConnector
} from './runtime-port-forward-tunnel'

/** A destination whose connect the test settles by hand, recording what the host wrote to it. */
class ManualSocket extends EventEmitter implements BrowserNetworkTunnelSocket {
  destroyed = false
  ended = false
  readonly writes: Buffer[] = []

  setNoDelay(): this {
    return this
  }
  pause(): this {
    return this
  }
  resume(): this {
    return this
  }
  write(bytes: Uint8Array<ArrayBufferLike>, callback?: () => void): boolean {
    this.writes.push(Buffer.from(bytes))
    queueMicrotask(() => callback?.())
    return true
  }
  end(): this {
    this.ended = true
    return this
  }
  destroy(): this {
    this.destroyed = true
    return this
  }
}

type Wire = {
  client: BrowserNetworkTunnelClient
  session: BrowserNetworkTunnelSession
  sockets: ManualSocket[]
  toSession: BrowserNetworkTunnelFrame[]
}

/** Client and host session joined in-process, like the paired WebSocket, with a frame log. */
function wire(options: { clientEarly: boolean; sessionEarly: boolean }): Wire {
  const sockets: ManualSocket[] = []
  const toSession: BrowserNetworkTunnelFrame[] = []
  let session: BrowserNetworkTunnelSession | null = null
  const client = new BrowserNetworkTunnelClient({
    tunnelGeneration: 1,
    sendBinary: (bytes) => {
      toSession.push(decodeBrowserNetworkTunnelFrame(bytes)!)
      queueMicrotask(() => session?.handleBinary(bytes))
      return true
    },
    flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
    earlyData: options.clientEarly
  })
  session = new BrowserNetworkTunnelSession({
    tunnelGeneration: 1,
    connect: () => {
      const socket = new ManualSocket()
      sockets.push(socket)
      return socket
    },
    sendBinary: (bytes) => {
      queueMicrotask(() => client.handleBinary(bytes))
      return true
    },
    flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
    earlyData: options.sessionEarly
  })
  return { client, session, sockets, toSession }
}

/** A host session driven by raw frames, recording what it sends and the destinations it dials. */
function rawSession(earlyData: boolean) {
  const sent: BrowserNetworkTunnelFrame[] = []
  const sockets: ManualSocket[] = []
  const listeners: ((frame: BrowserNetworkTunnelFrame) => void)[] = []
  let closed = false
  const session = new BrowserNetworkTunnelSession({
    tunnelGeneration: 1,
    connect: () => {
      const socket = new ManualSocket()
      sockets.push(socket)
      return socket
    },
    sendBinary: (bytes) => {
      const frame = decodeBrowserNetworkTunnelFrame(bytes)!
      sent.push(frame)
      for (const listener of listeners) {
        listener(frame)
      }
      return true
    },
    flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
    earlyData,
    onClose: () => {
      closed = true
    }
  })
  const send = (
    opcode: BrowserNetworkTunnelOpcode,
    streamId: number,
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array()
  ): void =>
    session.handleBinary(
      encodeBrowserNetworkTunnelFrame({ opcode, tunnelGeneration: 1, streamId, payload })
    )
  return {
    sent,
    sockets,
    send,
    open: (streamId: number) =>
      send(
        BrowserNetworkTunnelOpcode.Open,
        streamId,
        encodeBrowserNetworkTunnelOpen({ host: '127.0.0.1', port: 3000 })
      ),
    data: (streamId: number, bytes: number) =>
      send(BrowserNetworkTunnelOpcode.Data, streamId, new Uint8Array(bytes)),
    errors: () =>
      sent
        .filter((frame) => frame.opcode === BrowserNetworkTunnelOpcode.Error)
        .map((frame) => new TextDecoder().decode(frame.payload)),
    closed: () => closed,
    onSent: (listener: (frame: BrowserNetworkTunnelFrame) => void) => listeners.push(listener)
  }
}

/** Lets queued frames, write callbacks and socket events run (a few event-loop turns). */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function dataBytes(frames: BrowserNetworkTunnelFrame[]): number {
  return frames
    .filter((frame) => frame.opcode === BrowserNetworkTunnelOpcode.Data)
    .reduce((total, frame) => total + frame.payload.byteLength, 0)
}

describe('forward tunnel early data', () => {
  it('sends the request ahead of Opened and the host delivers it in order once connected', async () => {
    const { client, sockets, toSession } = wire({ clientEarly: true, sessionEarly: true })
    const socket = await client.open({ host: '127.0.0.1', port: 3000 })
    socket.write('GET / HTTP/1.1\r\n')
    socket.write('Host: x\r\n\r\n')
    socket.end()
    await settle()
    // Open, receive credit, both writes and the half-close all left before any Opened.
    expect(toSession.map((frame) => frame.opcode)).toEqual([
      BrowserNetworkTunnelOpcode.Open,
      BrowserNetworkTunnelOpcode.WindowUpdate,
      BrowserNetworkTunnelOpcode.Data,
      BrowserNetworkTunnelOpcode.Data,
      BrowserNetworkTunnelOpcode.HalfClose
    ])
    const destination = sockets[0]!
    expect(destination.writes).toEqual([])
    expect(destination.ended).toBe(false)
    destination.emit('connect')
    expect(Buffer.concat(destination.writes).toString()).toBe('GET / HTTP/1.1\r\nHost: x\r\n\r\n')
    expect(destination.ended).toBe(true)
    // The host can answer at once: the client's early credit already reached it.
    const reply = new Promise<string>((resolve) =>
      socket.once('data', (chunk) => resolve(`${chunk}`))
    )
    destination.emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n'))
    expect(await reply).toBe('HTTP/1.1 200 OK\r\n\r\n')
  })

  it('drops early data when the destination fails to connect', async () => {
    const { client, sockets } = wire({ clientEarly: true, sessionEarly: true })
    const socket = await client.open({ host: '127.0.0.1', port: 3000 })
    socket.write('never delivered')
    await settle()
    const destination = sockets[0]!
    destination.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
    const failure = await new Promise<Error>((resolve) => socket.once('error', resolve))
    expect(failure.message).toMatch(/destination failed/)
    // A later connect of the dead socket must not flush what was held.
    destination.emit('connect')
    await settle()
    expect(destination.writes).toEqual([])
    expect(destination.destroyed).toBe(true)
    expect(socket.destroyed).toBe(true)
  })

  it('sends only the early-data credit before Opened, the rest after', async () => {
    const { client, sockets, toSession } = wire({ clientEarly: true, sessionEarly: true })
    const socket = await client.open({ host: '127.0.0.1', port: 3000 })
    const payload = Buffer.alloc(BROWSER_NETWORK_TUNNEL_EARLY_DATA_BYTES + 40 * 1024, 1)
    socket.write(payload)
    await settle()
    expect(dataBytes(toSession)).toBe(BROWSER_NETWORK_TUNNEL_EARLY_DATA_BYTES)
    sockets[0]!.emit('connect')
    await vi.waitFor(() => expect(Buffer.concat(sockets[0]!.writes)).toEqual(payload))
  })

  it('closes the session when a peer overruns the early-data credit before connect', () => {
    const raw = rawSession(true)
    raw.open(1)
    raw.data(1, BROWSER_NETWORK_TUNNEL_EARLY_DATA_BYTES)
    raw.data(1, 1)
    expect(raw.errors()).toEqual(['receive_window_exceeded'])
    expect(raw.closed()).toBe(true)
    expect(raw.sockets[0]!.writes).toEqual([])
  })

  it('fails only the stream when early data is sliced into too many frames', () => {
    const raw = rawSession(true)
    raw.open(1)
    raw.open(3)
    for (let index = 0; index < 257; index += 1) {
      raw.data(1, 1)
    }
    expect(raw.errors()).toEqual(['early_data_chunk_overflow'])
    expect(raw.closed()).toBe(false)
    expect(raw.sockets[0]!.destroyed).toBe(true)
    raw.data(3, 10)
    raw.sockets[1]!.emit('connect')
    expect(Buffer.concat(raw.sockets[1]!.writes).byteLength).toBe(10)
  })

  it('drops early data when the client closes the stream before connect', () => {
    const raw = rawSession(true)
    raw.open(1)
    raw.data(1, 100)
    raw.send(BrowserNetworkTunnelOpcode.Close, 1)
    raw.sockets[0]!.emit('connect')
    expect(raw.sockets[0]!.writes).toEqual([])
    expect(raw.sockets[0]!.destroyed).toBe(true)
    expect(raw.closed()).toBe(false)
  })

  it('drops early data when the destination connect times out', () => {
    vi.useFakeTimers()
    try {
      const raw = rawSession(true)
      raw.open(1)
      raw.data(1, 100)
      vi.advanceTimersByTime(BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS)
      expect(raw.errors()).toEqual(['destination_connect_timeout'])
      raw.sockets[0]!.emit('connect')
      expect(raw.sockets[0]!.writes).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes held data before Opened leaves, so a synchronous peer cannot overtake it', () => {
    const raw = rawSession(true)
    raw.open(1)
    raw.data(1, 3)
    let writesWhenOpened = -1
    raw.onSent((frame) => {
      if (frame.opcode === BrowserNetworkTunnelOpcode.Opened) {
        writesWhenOpened = raw.sockets[0]!.writes.length
      }
    })
    raw.sockets[0]!.emit('connect')
    expect(writesWhenOpened).toBe(1)
  })

  it('tops the client up to the initial window when the destination connects', async () => {
    const sent: BrowserNetworkTunnelFrame[] = []
    const sockets: ManualSocket[] = []
    const session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 1,
      connect: () => {
        const socket = new ManualSocket()
        sockets.push(socket)
        return socket
      },
      sendBinary: (bytes) => (sent.push(decodeBrowserNetworkTunnelFrame(bytes)!), true),
      earlyData: true
    })
    session.handleBinary(
      encodeBrowserNetworkTunnelFrame({
        opcode: BrowserNetworkTunnelOpcode.Open,
        tunnelGeneration: 1,
        streamId: 1,
        payload: encodeBrowserNetworkTunnelOpen({ host: '127.0.0.1', port: 3000 })
      })
    )
    sockets[0]!.emit('connect')
    expect(sent.map((frame) => frame.opcode)).toEqual([
      BrowserNetworkTunnelOpcode.Opened,
      BrowserNetworkTunnelOpcode.WindowUpdate
    ])
    expect(decodeBrowserNetworkTunnelWindowUpdate(sent[1]!.payload)).toBe(
      BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES - BROWSER_NETWORK_TUNNEL_EARLY_DATA_BYTES
    )
  })

  it('keeps the strict ordering for a host without early data', async () => {
    // An old host fences the whole tunnel on data before Opened, so the client must not send it.
    const old = wire({ clientEarly: false, sessionEarly: false })
    const tunnel = new EnvironmentPortForwardTunnel('env', async () => ({
      client: old.client,
      close: () => old.client.close()
    }))
    let returned = false
    const opening = tunnel.open(3000).then((result) => ((returned = true), result))
    await settle()
    expect(returned).toBe(false)
    expect(old.toSession.map((frame) => frame.opcode)).toEqual([BrowserNetworkTunnelOpcode.Open])
    old.sockets[0]!.emit('connect')
    const remote = await opening
    remote.write('after-open')
    await vi.waitFor(() =>
      expect(Buffer.concat(old.sockets[0]!.writes).toString()).toBe('after-open')
    )
  })

  it.each([
    ['data', (raw: ReturnType<typeof rawSession>) => raw.data(1, 4)],
    [
      'credit',
      (raw: ReturnType<typeof rawSession>) =>
        raw.send(
          BrowserNetworkTunnelOpcode.WindowUpdate,
          1,
          encodeBrowserNetworkTunnelWindowUpdate(1024)
        )
    ],
    [
      'half-close',
      (raw: ReturnType<typeof rawSession>) => raw.send(BrowserNetworkTunnelOpcode.HalfClose, 1)
    ]
  ])('fences pre-Opened %s on a session that did not negotiate it', (_name, early) => {
    const raw = rawSession(false)
    raw.open(1)
    early(raw)
    expect(raw.closed()).toBe(true)
    expect(raw.sockets[0]!.writes).toEqual([])
  })
})

describe('RuntimePortForwardManager with early data', () => {
  const servers: Server[] = []
  let manager: RuntimePortForwardManager | null = null

  afterEach(() => {
    manager?.dispose()
    manager = null
    for (const server of servers.splice(0)) {
      server.close()
    }
  })

  function earlyConnector(frames: BrowserNetworkTunnelFrame[]): PortForwardTunnelConnector {
    return async (_environmentId, onClosed) => {
      let session: BrowserNetworkTunnelSession | null = null
      const client = new BrowserNetworkTunnelClient({
        tunnelGeneration: 1,
        sendBinary: (bytes) => {
          frames.push(decodeBrowserNetworkTunnelFrame(bytes)!)
          queueMicrotask(() => session?.handleBinary(bytes))
          return true
        },
        flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
        earlyData: true,
        onClosed
      })
      session = new BrowserNetworkTunnelSession({
        tunnelGeneration: 1,
        connect: createPortForwardDialer({}),
        sendBinary: (bytes) => {
          queueMicrotask(() => client.handleBinary(bytes))
          return true
        },
        flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
        earlyData: true
      })
      return { client, close: () => client.close() }
    }
  }

  function listen(server: Server): Promise<number> {
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(address && typeof address === 'object' ? address.port : 0)
      })
    })
  }

  function request(port: number, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port })
      const chunks: Buffer[] = []
      socket.on('data', (chunk) => chunks.push(chunk))
      socket.on('end', () => resolve(Buffer.concat(chunks).toString()))
      socket.on('error', reject)
      socket.end(payload)
    })
  }

  it('carries real connections end to end', async () => {
    const frames: BrowserNetworkTunnelFrame[] = []
    manager = new RuntimePortForwardManager({ connector: earlyConnector(frames) })
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      const chunks: Buffer[] = []
      socket.on('data', (chunk) => chunks.push(chunk))
      socket.on('end', () => socket.end(`echo:${Buffer.concat(chunks).toString()}`))
    })
    servers.push(server)
    const remotePort = await listen(server)
    const result = await manager.open({
      environmentId: 'e',
      remotePort,
      localPort: 0,
      reason: 'user'
    })
    if (!result.ok) {
      throw new Error('expected forward')
    }
    const answers = await Promise.all(
      Array.from({ length: 6 }, (_, index) => request(result.forward.localPort, `hi-${index}`))
    )
    expect(answers).toEqual(Array.from({ length: 6 }, (_, index) => `echo:hi-${index}`))
    expect(manager.list()[0]?.lastError).toBeUndefined()
  })

  it('leaves no error when the local app hangs up before the host connects', async () => {
    // A host that never answers: the stream stays before Opened until the local app gives up.
    manager = new RuntimePortForwardManager({
      connector: async (_environmentId, onClosed) => {
        const client = new BrowserNetworkTunnelClient({
          tunnelGeneration: 1,
          sendBinary: () => true,
          flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
          earlyData: true,
          onClosed
        })
        return { client, close: () => client.close() }
      }
    })
    const result = await manager.open({
      environmentId: 'e',
      remotePort: 3000,
      localPort: 0,
      reason: 'user'
    })
    if (!result.ok) {
      throw new Error('expected forward')
    }
    const socket = connect({ host: '127.0.0.1', port: result.forward.localPort })
    socket.on('error', () => {})
    socket.write('GET / HTTP/1.1\r\n\r\n')
    await vi.waitFor(() => expect(manager?.list()[0]?.bytesToHost).toBeGreaterThan(0))
    // A reset, as a browser canceling a preconnect sends; a plain FIN would wait for the reply.
    socket.resetAndDestroy()
    await vi.waitFor(() => expect(manager?.list()[0]?.openConnections).toBe(0))
    await settle()
    expect(manager.list()[0]?.lastError).toBeUndefined()
  })

  it('records the host failure when nothing listens on the remote port', async () => {
    manager = new RuntimePortForwardManager({ connector: earlyConnector([]) })
    const probe = createServer()
    const unused = await listen(probe)
    await new Promise((resolve) => probe.close(resolve))
    const result = await manager.open({
      environmentId: 'e',
      remotePort: unused,
      localPort: 0,
      reason: 'user'
    })
    if (!result.ok) {
      throw new Error('expected forward')
    }
    await request(result.forward.localPort, 'x').catch(() => '')
    await vi.waitFor(() => expect(manager?.list()[0]?.lastError).toBeTruthy())
  })
})
