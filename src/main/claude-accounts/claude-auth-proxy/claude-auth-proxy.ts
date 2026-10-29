import { randomBytes } from 'node:crypto'
import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { bindHostIsNetworkExposed, ORCAD_LOOPBACK_BIND_HOST } from '../../orcad/orcad-bind-address'
import type { ClaudeAuthProxyStatus } from '../../../shared/claude-auth-proxy-status'
import { forwardRequestHeaders, forwardResponseHeaders } from './claude-auth-proxy-headers'
import { createClaudeAuthProxyRequestLog } from './claude-auth-proxy-request-log'
import { createClaudeAuthProxyTokenCache } from './claude-auth-proxy-token-cache'

const UPSTREAM_ORIGIN = 'https://api.anthropic.com'
const SLOT_PATH = /^\/p\/([^/]+)(\/.*)?$/
/** 16 bytes: a slot id is an unguessable capability, not a sequential id. */
const SLOT_ID_BYTES = 16
/**
 * Claude Code's own request budget is 10 minutes of inactivity. Node's default
 * requestTimeout is 5 minutes and would cut a live stream first, so it is disabled
 * on this loopback listener and the socket idle timer carries the 10 minute budget.
 */
export const CLAUDE_AUTH_PROXY_IDLE_TIMEOUT_MS = 10 * 60 * 1000
/**
 * A macOS `security` lookup measured ~317 ms median on 2026-10-29, past the 5 ms
 * re-read budget. A hit serves the last token; a snapshot change drops it sooner.
 */
export const CLAUDE_AUTH_PROXY_TOKEN_TTL_MS = 20_000

export type ClaudeAuthProxy = {
  start: () => Promise<void>
  /** Stops accepting. In-flight responses finish; idle keep-alives close. */
  stop: () => Promise<void>
  port: () => number | null
  allocateSlot: (accountId: string) => string
  assignSlot: (slot: string, accountId: string) => boolean
  accountIdForSlot: (slot: string) => string | null
  /** Trailing slash so Claude's `/v1/...` join keeps the `/p/<slot>/` prefix. */
  slotBaseUrl: (slot: string) => string | null
  releaseSlot: (slot: string) => void
  /** Drops one account, or every account when `accountId` is omitted. */
  invalidateToken: (accountId?: string) => void
  status: () => ClaudeAuthProxyStatus
}

export type ClaudeAuthProxyOptions = {
  readToken: (accountId: string) => Promise<string | null>
  /** Defaults to https://api.anthropic.com. Tests inject a loopback upstream. */
  upstream?: string
  log?: (line: string) => void
  /** Literal loopback IP. Anything routable is refused. */
  bindHost?: string
  /** Defaults to {@link CLAUDE_AUTH_PROXY_TOKEN_TTL_MS}. `0` re-reads every request. */
  tokenTtlMs?: number
  /** Socket inactivity budget. Defaults to Claude's 10 minutes. */
  idleTimeoutMs?: number
  now?: () => number
}

export function createClaudeAuthProxy(options: ClaudeAuthProxyOptions): ClaudeAuthProxy {
  const bindHost = options.bindHost ?? ORCAD_LOOPBACK_BIND_HOST
  if (bindHostIsNetworkExposed(bindHost)) {
    throw new Error('claude auth proxy only binds to loopback')
  }
  const slots = new Map<string, string>()
  const upstream = options.upstream ?? UPSTREAM_ORIGIN
  const log = options.log ?? (() => {})
  const now = options.now ?? Date.now
  const tokens = createClaudeAuthProxyTokenCache({
    ttlMs: options.tokenTtlMs ?? CLAUDE_AUTH_PROXY_TOKEN_TTL_MS,
    now,
    readToken: options.readToken
  })
  const requests = createClaudeAuthProxyRequestLog(now, log)
  const idleTimeoutMs = options.idleTimeoutMs ?? CLAUDE_AUTH_PROXY_IDLE_TIMEOUT_MS
  const httpAgent = new HttpAgent({ keepAlive: true })
  const httpsAgent = new HttpsAgent({ keepAlive: true })
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(502)
      }
      res.end()
    })
  })
  // The 5-minute default aborts the whole request, including a long SSE body.
  server.requestTimeout = 0
  server.timeout = idleTimeoutMs
  server.headersTimeout = 60_000
  let listening: Promise<void> | null = null
  let stopping: Promise<void> | null = null
  let closing = false

  function port(): number | null {
    const address = server.address()
    return address && typeof address === 'object' ? address.port : null
  }

  function start(): Promise<void> {
    if (server.listening) {
      return Promise.resolve()
    }
    if (listening) {
      return listening
    }
    listening = new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        server.off('listening', ready)
        reject(error)
      }
      const ready = (): void => {
        server.off('error', fail)
        resolve()
      }
      server.once('error', fail)
      server.once('listening', ready)
      server.listen(0, bindHost)
    })
    return listening
  }

  function destroyAgents(): void {
    httpAgent.destroy()
    httpsAgent.destroy()
  }

  function stop(): Promise<void> {
    if (stopping) {
      return stopping
    }
    closing = true
    const finish = (): void => {
      tokens.invalidate()
      slots.clear()
      destroyAgents()
    }
    if (!server.listening) {
      stopping = Promise.resolve().then(finish)
      return stopping
    }
    // Drop keep-alives that have no request. Active responses stay until they end.
    server.closeIdleConnections()
    stopping = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    }).then(finish, (error: unknown) => {
      finish()
      throw error
    })
    return stopping
  }

  function releaseIdleAfterClose(res: ServerResponse): void {
    res.on('close', () => {
      if (!closing) {
        return
      }
      setImmediate(() => {
        if (closing) {
          server.closeIdleConnections()
        }
      })
    })
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    const match = requestUrl.pathname.match(SLOT_PATH)
    const slot = match?.[1]
    const upstreamPath = match
      ? match[2] && match[2] !== '/'
        ? match[2]
        : '/'
      : requestUrl.pathname
    const knownAccount = slot ? slots.get(slot) : undefined
    const unknownSlot = Boolean(slot && knownAccount === undefined)
    const accountId = knownAccount ?? null
    const method = req.method ?? 'GET'
    // Read before opening upstream so a slot flip during this body cannot change it.
    const token = accountId ? await tokens.tokenFor(accountId) : null
    const headers = forwardRequestHeaders(req.headers)
    if (token) {
      headers.authorization = `Bearer ${token}`
    }
    const target = new URL(`${upstreamPath}${requestUrl.search}`, upstream)
    let settled = false
    const onResponse = (upstreamRes: IncomingMessage): void => {
      settled = true
      const status = upstreamRes.statusCode ?? 502
      requests.observe(method, upstreamPath, status, accountId, unknownSlot)
      res.writeHead(status, forwardResponseHeaders(upstreamRes.headers))
      upstreamRes.on('error', () => {
        if (!res.writableEnded) {
          res.destroy()
        }
      })
      // pipe pauses upstream when the client stops reading.
      upstreamRes.pipe(res)
    }
    const upstreamReq =
      target.protocol === 'https:'
        ? httpsRequest(target, { method, headers, agent: httpsAgent }, onResponse)
        : httpRequest(target, { method, headers, agent: httpAgent }, onResponse)
    upstreamReq.setTimeout(idleTimeoutMs, () => upstreamReq.destroy())
    upstreamReq.on('error', () => {
      if (settled || res.headersSent || res.writableEnded) {
        if (!res.writableEnded) {
          res.destroy()
        }
        return
      }
      settled = true
      requests.observe(method, upstreamPath, 502, accountId, unknownSlot)
      res.writeHead(502)
      res.end()
    })
    const abortUpstream = (): void => {
      upstreamReq.destroy()
    }
    req.on('aborted', abortUpstream)
    req.on('error', abortUpstream)
    releaseIdleAfterClose(res)
    // Pipe the body. Do not buffer it: /compact posts are hundreds of kilobytes.
    req.pipe(upstreamReq)
  }

  return {
    start,
    stop,
    port,
    allocateSlot(accountId) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const slot = randomBytes(SLOT_ID_BYTES).toString('hex')
        if (!slots.has(slot)) {
          slots.set(slot, accountId)
          return slot
        }
      }
      throw new Error('claude auth proxy could not allocate a slot')
    },
    assignSlot(slot, accountId) {
      if (!slots.has(slot)) {
        return false
      }
      slots.set(slot, accountId)
      return true
    },
    accountIdForSlot(slot) {
      return slots.get(slot) ?? null
    },
    slotBaseUrl(slot) {
      const current = port()
      if (current === null || !slots.has(slot)) {
        return null
      }
      return `http://${bindHost}:${current}/p/${slot}/`
    },
    releaseSlot(slot) {
      slots.delete(slot)
    },
    invalidateToken(accountId) {
      tokens.invalidate(accountId)
    },
    status() {
      return {
        listening: server.listening,
        host: bindHost,
        port: port(),
        slots: [...slots.entries()].map(([slot, accountId]) => ({ slot, accountId })),
        ...requests.snapshot()
      }
    }
  }
}
