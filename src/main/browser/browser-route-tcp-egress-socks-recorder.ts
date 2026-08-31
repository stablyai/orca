import { createServer, type Server, Socket } from 'node:net'

const SOCKS_VERSION = 5
const SOCKS_NO_AUTH = 0
const SOCKS_CONNECT = 1
const SOCKS_GENERAL_FAILURE = 1
const SOCKS_COMMAND_NOT_SUPPORTED = 7

export function createBrowserRouteTcpEgressSocksRecorder(
  allowedPorts: Set<number>,
  routedSourcePorts: Set<number>,
  hosts: Set<string>,
  sockets: Set<Socket>
): Server {
  return createServer((client) => {
    trackSocket(client, sockets)
    let buffer = Buffer.alloc(0) as Buffer<ArrayBufferLike>
    let greeted = false
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (!greeted) {
        const greeting = parseSocksGreeting(buffer)
        if (!greeting) {
          return
        }
        if (greeting.invalid) {
          closeWithSocksError(client, 0xff)
          return
        }
        buffer = greeting.remainder
        greeted = true
        client.write(Buffer.from([SOCKS_VERSION, SOCKS_NO_AUTH]))
      }
      const request = parseSocksRequest(buffer)
      if (!request) {
        return
      }
      if (request.invalid) {
        closeWithSocksError(client, request.status)
        return
      }
      client.off('data', onData)
      hosts.add(request.host)
      if (!allowedPorts.has(request.port)) {
        client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]))
        return
      }
      connectSocksUpstream(client, request.port, request.remainder, routedSourcePorts, sockets)
    }
    client.on('data', onData)
  })
}

function parseSocksGreeting(
  buffer: Buffer
): { invalid: true } | { invalid: false; remainder: Buffer } | null {
  if (buffer.length < 2) {
    return null
  }
  const methodCount = buffer[1] ?? 0
  const greetingLength = 2 + methodCount
  if (buffer.length < greetingLength) {
    return null
  }
  if (buffer[0] !== SOCKS_VERSION || !buffer.subarray(2, greetingLength).includes(SOCKS_NO_AUTH)) {
    return { invalid: true }
  }
  return { invalid: false, remainder: buffer.subarray(greetingLength) }
}

function parseSocksRequest(
  buffer: Buffer
):
  | { invalid: false; host: string; port: number; remainder: Buffer }
  | { invalid: true; status: number }
  | null {
  if (buffer.length < 5) {
    return null
  }
  if (buffer[0] !== SOCKS_VERSION || buffer[2] !== 0) {
    return { invalid: true, status: SOCKS_GENERAL_FAILURE }
  }
  if (buffer[1] !== SOCKS_CONNECT) {
    return { invalid: true, status: SOCKS_COMMAND_NOT_SUPPORTED }
  }
  const type = buffer[3]
  const addressLength = type === 1 ? 4 : type === 4 ? 16 : type === 3 ? (buffer[4] ?? 0) + 1 : 0
  const requestLength = 4 + addressLength + 2
  if (addressLength === 0 || buffer.length < requestLength) {
    if (addressLength === 0) {
      return { invalid: true, status: SOCKS_GENERAL_FAILURE }
    }
    return null
  }
  const host =
    type === 3
      ? buffer.subarray(5, 5 + (buffer[4] ?? 0)).toString('utf8')
      : type === 1
        ? [...buffer.subarray(4, 8)].join('.')
        : 'ipv6'
  return {
    invalid: false,
    host,
    port: buffer.readUInt16BE(requestLength - 2),
    remainder: buffer.subarray(requestLength)
  }
}

function closeWithSocksError(client: Socket, status: number): void {
  client.end(Buffer.from([SOCKS_VERSION, status, 0, 1, 0, 0, 0, 0, 0, 0]))
}

function connectSocksUpstream(
  client: Socket,
  port: number,
  remainder: Buffer,
  routedSourcePorts: Set<number>,
  sockets: Set<Socket>
): void {
  const upstream = new Socket()
  trackSocket(upstream, sockets)
  upstream.connect(port, '127.0.0.1', () => {
    const sourcePort = upstream.localPort ?? -1
    if (sourcePort > 0) {
      routedSourcePorts.add(sourcePort)
    }
    const removeSourcePort = (): void => {
      if (sourcePort > 0) {
        routedSourcePorts.delete(sourcePort)
      }
    }
    upstream.once('close', removeSourcePort)
    client.once('close', removeSourcePort)
    client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
    if (remainder.length > 0) {
      upstream.write(remainder)
    }
    client.pipe(upstream).pipe(client)
  })
  upstream.on('error', () => client.destroy())
  client.on('error', () => upstream.destroy())
  client.once('close', () => upstream.destroy())
}

function trackSocket(socket: Socket, sockets: Set<Socket>): void {
  sockets.add(socket)
  socket.on('error', () => socket.destroy())
  socket.once('close', () => sockets.delete(socket))
}
