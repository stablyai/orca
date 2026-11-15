// CODEX-RELAY: chatgpt.com refuses Cloudflare Workers' egress, so the sandbox-control egress proxy
// sends its chatgpt.com requests here (Cloud Run, which ChatGPT answers). The Worker already chose the
// credential and pinned the path; this relay pins the path again, forwards to chatgpt.com only, and
// streams the answer back as it arrives (Codex reads Server-Sent Events).
// Cloud Run IAM authenticates the Worker (an ID token in X-Serverless-Authorization, run.invoker on
// one service account): nothing unauthenticated reaches this code. No header or body is ever logged.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { codexPathAllowed } from '../../sandbox-control/src/codex-paths.ts'

export const UPSTREAM_ORIGIN = 'https://chatgpt.com'

/** Never forwarded: hop-by-hop, Cloud Run's own auth and tracing, and proxy breadcrumbs. */
const DROP_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'x-serverless-authorization',
  'forwarded',
  'traceparent',
  'tracestate',
  'x-cloud-trace-context'
])
const DROP_REQUEST_PREFIXES = ['x-forwarded-', 'x-goog-', 'cf-']

/** fetch already decoded the body, so its encoding and length no longer describe what we send. */
const DROP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'trailer',
  'upgrade'
])

export type RelayDeps = {
  fetch?: typeof fetch
  log?: (line: Record<string, unknown>) => void
  now?: () => number
}

function refuse(res: ServerResponse, status: number, reason: string): void {
  res.writeHead(status, { 'content-type': 'text/plain' })
  res.end(reason)
}

/** The first two path segments only (e.g. /backend-api/codex): never ids or queries. */
function pathLabel(path: string): string {
  return (path.split('?')[0] ?? '').split('/').slice(0, 3).join('/')
}

export function forwardHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    const key = name.toLowerCase()
    if (value === undefined || DROP_REQUEST.has(key) || DROP_REQUEST_PREFIXES.some((p) => key.startsWith(p))) {
      continue
    }
    for (const one of Array.isArray(value) ? value : [value]) {
      headers.append(key, one)
    }
  }
  return headers
}

export function createRelay(deps: RelayDeps = {}) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)))
  const now = deps.now ?? Date.now
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = now()
    const method = (req.method ?? 'GET').toUpperCase()
    const path = req.url ?? '/'
    if (path === '/health' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    // Codex is configured for HTTPS (supports_websockets = false); the Worker proxy can't upgrade either.
    if (req.headers.upgrade) {
      refuse(res, 426, 'upgrade_not_supported')
      return
    }
    if (!path.startsWith('/') || !codexPathAllowed(method, path)) {
      log({ event: 'relay_refused', reason: 'path_not_allowed', method, path: pathLabel(path) })
      refuse(res, 403, 'path_not_allowed')
      return
    }
    const hasBody = method !== 'GET' && method !== 'HEAD'
    const abort = new AbortController()
    // The VM's client went away: stop reading from chatgpt.com too.
    res.on('close', () => {
      if (!res.writableFinished) {
        abort.abort()
      }
    })
    let upstream: Response
    try {
      upstream = await doFetch(`${UPSTREAM_ORIGIN}${path}`, {
        method,
        headers: forwardHeaders(req),
        body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
        // Node needs this for a streamed request body.
        ...(hasBody ? { duplex: 'half' } : {}),
        redirect: 'manual',
        signal: abort.signal
      } as RequestInit)
    } catch {
      log({ event: 'relay_upstream_failed', method, path: pathLabel(path), ms: now() - started })
      if (!res.headersSent) {
        refuse(res, 502, 'upstream_unreachable')
      }
      return
    }
    const headers: Record<string, string[]> = {}
    upstream.headers.forEach((value, name) => {
      if (!DROP_RESPONSE.has(name.toLowerCase())) {
        ;(headers[name] ??= []).push(value)
      }
    })
    res.writeHead(upstream.status, headers)
    // Each chunk is written as it arrives: SSE events reach Codex without buffering.
    res.flushHeaders()
    if (upstream.body) {
      try {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(chunk)
        }
      } catch {
        // The client left (abort) or chatgpt.com cut the stream: end what was sent.
      }
    }
    res.end()
    log({ event: 'relay', method, path: pathLabel(path), status: upstream.status, ms: now() - started })
  }
}
