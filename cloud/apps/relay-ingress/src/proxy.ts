// Stateless ingress for the relay edge: terminates TLS for one public hostname and re-originates
// every request to the edge Worker over TLS, adding the signed ingress header (origin the client
// dialled + client address). WebSocket upgrades become a raw byte pipe once the request head is
// sent, so frames, close codes and the edge's own refusals pass through unchanged.
// Logs carry counts only: never addresses, paths (they hold host ids) or headers (they hold tokens).
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Agent, createServer as createHttpsServer, request as httpsRequest } from 'node:https'
import { isIP, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { INGRESS_HEADER, signIngressHeader } from '@orca-cloud/relay-contract/ingress-header'

export type IngressConfig = {
  name: string
  publicOrigin: string
  upstream: URL
  secret: string
  // Extra trust for the upstream certificate (local tests only; production uses the system store).
  upstreamCa?: string | Buffer
  tls: { key: string | Buffer; cert: string | Buffer }
  idleTimeoutMs: number
  // SIGTERM: health fails at once; after drainDelayMs (load balancer notices) the listener closes;
  // tunnels still open after drainMs more are cut.
  drainDelayMs: number
  drainMs: number
  log?: (event: Record<string, unknown>) => void
}

// Inbound headers a client must never be able to set on the edge hop, and hop-by-hop headers.
const STRIPPED = /^(host|x-orca-ingress.*|x-edge-.*|cf-.*|x-forwarded-.*|forwarded|x-real-ip|true-client-ip)$/i
const HOP = /^(connection|keep-alive|proxy-connection|proxy-authorization|te|trailer|transfer-encoding|upgrade)$/i
const ROUTED = /^\/(health$|v1\/)/

const clientIp = (socket: Socket) => (socket.remoteAddress ?? '').replace(/^::ffff:(?=\d+\.)/, '')
const route = (path: string) => /^\/v1\/(host\/control|connect|host\/data)/.exec(path)?.[1]?.replace('host/', '') ?? 'other'

export function createIngressProxy(config: IngressConfig) {
  const log = config.log ?? ((event) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event })))
  const upstreamPort = Number(config.upstream.port || 443)
  const servername = isIP(config.upstream.hostname) ? undefined : config.upstream.hostname
  const agent = new Agent({ keepAlive: true, servername, ca: config.upstreamCa })
  const tunnels = new Set<Socket>()
  const stats = { tunnels: 0, opened: 0, upstreamErrors: 0, upgrades: {} as Record<string, number>, requests: 0 }
  let draining = false

  async function outboundHeaders(req: IncomingMessage, keepHop: boolean): Promise<[string, string][]> {
    const out: [string, string][] = []
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]!
      if (STRIPPED.test(name) || (!keepHop && HOP.test(name))) continue
      out.push([name, req.rawHeaders[i + 1]!])
    }
    out.push(['host', config.upstream.host])
    out.push([INGRESS_HEADER, await signIngressHeader(config.secret, { name: config.name, origin: config.publicOrigin, clientIp: clientIp(req.socket) })])
    return out
  }

  function idle(socket: Socket, onIdle: () => void): void {
    socket.setTimeout(config.idleTimeoutMs, onIdle)
    socket.setKeepAlive(true, 30_000)
    socket.setNoDelay(true)
  }

  async function onUpgrade(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    client.on('error', () => client.destroy())
    if (draining || !ROUTED.test(req.url ?? '')) {
      client.end(`HTTP/1.1 ${draining ? 503 : 404} ${draining ? 'Service Unavailable' : 'Not Found'}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
      return
    }
    const kind = route(req.url ?? '')
    const headers = await outboundHeaders(req, true)
    const upstream = tlsConnect({ host: config.upstream.hostname, port: upstreamPort, servername, ca: config.upstreamCa, ALPNProtocols: ['http/1.1'] })
    tunnels.add(client)
    stats.opened++
    stats.tunnels = tunnels.size
    const both = () => {
      client.destroy()
      upstream.destroy()
    }
    idle(client, both)
    idle(upstream, both)
    upstream.on('error', () => {
      stats.upstreamErrors++
      if (!client.writable || client.bytesWritten > 0) return both()
      client.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
    })
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers.map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`)
    if (head.length) upstream.write(head)
    upstream.once('data', (chunk: Buffer) => {
      const status = `${kind}:${chunk.subarray(9, 12).toString('latin1')}`
      stats.upgrades[status] = (stats.upgrades[status] ?? 0) + 1
    })
    // Byte pipe both ways. A FIN on one side half-closes the other once its writes have flushed.
    upstream.pipe(client)
    client.pipe(upstream)
    client.on('close', () => {
      tunnels.delete(client)
      stats.tunnels = tunnels.size
      upstream.end()
      setTimeout(() => upstream.destroy(), 5_000).unref()
    })
    upstream.on('close', () => {
      client.end()
      setTimeout(() => client.destroy(), 5_000).unref()
    })
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!ROUTED.test(req.url ?? '')) {
      res.writeHead(404, { 'content-length': 0 }).end()
      return
    }
    stats.requests++
    const upstream = httpsRequest({
      agent,
      host: config.upstream.hostname,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: (await outboundHeaders(req, false)).flat()
    })
    upstream.on('response', (up) => {
      const headers: string[] = []
      for (let i = 0; i < up.rawHeaders.length; i += 2) if (!HOP.test(up.rawHeaders[i]!)) headers.push(up.rawHeaders[i]!, up.rawHeaders[i + 1]!)
      res.writeHead(up.statusCode ?? 502, headers)
      up.pipe(res)
    })
    upstream.on('error', () => {
      stats.upstreamErrors++
      if (!res.headersSent) res.writeHead(502, { 'content-length': 0 })
      res.end()
    })
    req.pipe(upstream)
  }

  const server = createHttpsServer({ ...config.tls, ALPNProtocols: ['http/1.1'] })
  server.keepAliveTimeout = 65_000
  server.on('request', (req, res) => void onRequest(req, res).catch(() => res.destroy()))
  server.on('upgrade', (req, socket: Socket, head) => void onUpgrade(req, socket, head).catch(() => socket.destroy()))
  server.on('tlsClientError', () => {})

  // Load balancer health and counters, on a separate plain port that is never public.
  const health = createHttpServer((req, res) => {
    if (req.url === '/stats') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ draining, ...stats }))
    res.writeHead(draining ? 503 : 200, { 'content-length': 0 }).end()
  })

  async function drain(): Promise<void> {
    if (draining) return
    draining = true
    log({ event: 'drain_start', tunnels: tunnels.size })
    await new Promise((r) => setTimeout(r, config.drainDelayMs))
    server.close()
    server.closeIdleConnections()
    const deadline = Date.now() + config.drainMs
    while (tunnels.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
    const cut = tunnels.size
    for (const socket of tunnels) socket.destroy()
    server.closeAllConnections()
    health.close()
    agent.destroy()
    log({ event: 'drain_done', cut })
  }

  return { server, health, drain, stats, reloadTls: (tls: IngressConfig['tls']) => server.setSecureContext(tls), log }
}
