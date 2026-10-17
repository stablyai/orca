import { createServer, type Server } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { createHash } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RemoteBrowserSocksServer,
  type RemoteBrowserNetworkTarget
} from '../../../src/main/browser/remote-browser-socks-server'

type FixtureNetworkEvent =
  | { event: 'http'; route: string; host: string | undefined; path: string | undefined }
  | { event: 'websocket'; route: string; host: string | undefined }
  | ({ event: 'socks-connect'; route: string; tunnelDown: boolean } & RemoteBrowserNetworkTarget)
  | { event: 'control'; path: string | undefined }

const directory = process.argv[2]
if (!directory) {
  throw new Error('Expected artifact directory')
}
const sockets = new Set<Socket>()
const log = (event: FixtureNetworkEvent): void => {
  appendFileSync(
    join(directory, 'network.jsonl'),
    JSON.stringify({ time: Date.now(), ...event }) + '\n'
  )
}

async function listen(server: Server, host: string): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing listener address')
  }
  return address.port
}

function site(route: string): Server {
  const server = createServer((request, response) => {
    log({ event: 'http', route, host: request.headers.host, path: request.url })
    response.writeHead(200, {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    })
    response.end(request.url?.startsWith('/fetch') ? route : `<body>${route}</body>`)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (request, socket) => {
    log({ event: 'websocket', route, host: request.headers.host })
    const accept = createHash('sha1')
      .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    const message = Buffer.from(`hmr:${route}`)
    socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]))
    socket.on('data', () => socket.end())
    socket.on('error', () => socket.destroy())
  })
  return server
}

async function main(): Promise<void> {
  const trap = site('DIRECT-BYPASS')
  const origin = await listen(trap, '::')
  const routeA = site('A')
  const routeB = site('B')
  const upstreamA = await listen(routeA, '127.0.0.1')
  const upstreamB = await listen(routeB, '127.0.0.1')
  let tunnelDown = false
  const connectionsA = new Set<Socket>()
  const proxy = (route: string, port: number): RemoteBrowserSocksServer =>
    new RemoteBrowserSocksServer({
      open: async (target) => {
        log({ event: 'socks-connect', route, ...target, tunnelDown })
        if (target.port !== origin || (route === 'A' && tunnelDown)) {
          throw new Error('Route unavailable')
        }
        return await new Promise<Socket>((resolve, reject) => {
          const socket = createConnection({ host: '127.0.0.1', port })
          if (route === 'A') {
            connectionsA.add(socket)
          }
          socket.once('close', () => connectionsA.delete(socket))
          socket.once('connect', () => resolve(socket))
          socket.once('error', reject)
        })
      }
    })
  const a = proxy('A', upstreamA)
  const b = proxy('B', upstreamB)
  const addressA = await a.listen()
  const addressB = await b.listen()
  const control = createServer((request, response) => {
    void (async () => {
      if (request.url === '/tunnel-down') {
        tunnelDown = true
        for (const socket of connectionsA) {
          socket.destroy()
        }
      } else if (request.url === '/listener-down') {
        await a.close()
      }
      log({ event: 'control', path: request.url })
      response.end('ok')
    })()
  })
  const controlPort = await listen(control, '127.0.0.1')
  writeFileSync(
    join(directory, 'ports.json'),
    JSON.stringify({ a: addressA.port, b: addressB.port, origin, control: controlPort })
  )
  const cleanup = async (): Promise<void> => {
    await Promise.all([a.close(), b.close()])
    for (const socket of sockets) {
      socket.destroy()
    }
    for (const server of [trap, routeA, routeB, control]) {
      server.close()
    }
  }
  process.once('SIGTERM', () => {
    void cleanup()
  })
  process.once('SIGINT', () => {
    void cleanup()
  })
}

void main()
