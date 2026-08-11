// Why: the localhost worktree-label proxy and the serve preview proxy route by
// hostname differently but forward identically. Keeping the request/upgrade
// forwarding in one place keeps streaming, header, and teardown behavior in
// lockstep between them.
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { URL } from 'node:url'
import { connectableLoopbackHost } from '../shared/localhost-worktree-labels'

const HTTP_CONNECT_TIMEOUT_MS = 10_000
const HTTP_RESPONSE_TIMEOUT_MS = 60_000

export function forwardHttpRequestToTarget(options: {
  target: URL
  request: IncomingMessage
  response: ServerResponse
  /** Names the route in the 502 body so failures are attributable. */
  routeLabel: string
  /** Cookies the proxy owns; never handed to the target. */
  stripCookies?: readonly string[]
}): void {
  const { request, response, routeLabel } = options
  const target = targetUrlForRequest(options.target, request)
  const proxyRequest = requestForTarget(target, {
    method: request.method,
    headers: requestHeadersForTarget(request, options.target, options.stripCookies)
  })
  let proxyResponse: IncomingMessage | null = null
  let connectTimeout: ReturnType<typeof setTimeout> | null = null
  let responseTimeout: ReturnType<typeof setTimeout> | null = null
  let responseStarted = false
  const clearConnectTimeout = (): void => {
    if (connectTimeout) {
      clearTimeout(connectTimeout)
      connectTimeout = null
    }
  }
  const clearResponseTimeout = (): void => {
    if (responseTimeout) {
      clearTimeout(responseTimeout)
      responseTimeout = null
    }
  }
  const destroyUpstream = (): void => {
    clearConnectTimeout()
    clearResponseTimeout()
    proxyResponse?.destroy()
    proxyRequest.destroy()
  }

  // Why: a client abort or downstream socket error must tear down the
  // upstream request instead of surfacing as an uncaught exception/leak.
  request.on('aborted', destroyUpstream)
  request.on('error', destroyUpstream)
  response.on('error', destroyUpstream)
  response.on('close', () => {
    if (!response.writableFinished) {
      destroyUpstream()
    }
  })
  proxyRequest.once('socket', (socket) => {
    if (!socket.connecting) {
      return
    }
    connectTimeout = setTimeout(() => {
      proxyRequest.destroy(new Error('Upstream connection timed out.'))
    }, HTTP_CONNECT_TIMEOUT_MS)
    connectTimeout.unref?.()
    socket.once('connect', clearConnectTimeout)
  })
  // Why: start the response deadline after uploads finish, then clear it at
  // headers so long-lived response streams remain unrestricted.
  proxyRequest.once('finish', () => {
    if (responseStarted) {
      return
    }
    responseTimeout = setTimeout(() => {
      proxyRequest.destroy(new Error('Upstream response timed out.'))
    }, HTTP_RESPONSE_TIMEOUT_MS)
    responseTimeout.unref?.()
  })

  // Why: the proxy only relabels the hostname; responses are streamed
  // through untouched so app headers (CSP, cookies) and bodies are
  // preserved exactly as the dev server sent them.
  proxyRequest.on('response', (upstreamResponse) => {
    responseStarted = true
    clearConnectTimeout()
    clearResponseTimeout()
    proxyResponse = upstreamResponse
    upstreamResponse.on('error', () => response.destroy())
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
    upstreamResponse.pipe(response)
  })
  proxyRequest.on('error', (error) => {
    clearConnectTimeout()
    clearResponseTimeout()
    if (response.destroyed || response.writableEnded) {
      return
    }
    // Why: once headers/bytes are flushed we can't write a 502, so tear the
    // socket down to avoid an ERR_HTTP_HEADERS_SENT crash.
    if (response.headersSent) {
      response.destroy(error)
      return
    }
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(`Proxy failed for ${routeLabel}: ${error.message}`)
  })
  request.pipe(proxyRequest)
}

const UPGRADE_CONNECT_TIMEOUT_MS = 10_000

export function forwardUpgradeToTarget(options: {
  target: URL
  request: IncomingMessage
  socket: Duplex
  head: Buffer
  /** Cookies the proxy owns; never handed to the target. */
  stripCookies?: readonly string[]
}): void {
  const { request, socket, head } = options
  const target = targetUrlForRequest(options.target, request)
  const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
  const targetSocket = net.connect(targetPort, connectableLoopbackHost(target.hostname), () => {
    // Why: the timeout only guards the connect phase — an established WebSocket
    // (HMR) legitimately sits idle far longer than any sane connect takes.
    targetSocket.setTimeout(0)
    const headers = requestHeadersForTarget(request, options.target, options.stripCookies)
    targetSocket.write(
      `${request.method ?? 'GET'} ${target.pathname}${target.search} HTTP/${request.httpVersion}\r\n`
    )
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          targetSocket.write(`${name}: ${entry}\r\n`)
        }
      } else if (value !== undefined) {
        targetSocket.write(`${name}: ${value}\r\n`)
      }
    }
    targetSocket.write('\r\n')
    if (head.length > 0) {
      targetSocket.write(head)
    }
    targetSocket.pipe(socket)
    socket.pipe(targetSocket)
  })
  targetSocket.setTimeout(UPGRADE_CONNECT_TIMEOUT_MS, () => {
    targetSocket.destroy()
    socket.destroy()
  })
  targetSocket.on('error', () => socket.destroy())
  targetSocket.on('end', () => socket.destroy())
  targetSocket.on('close', () => socket.destroy())
  socket.on('error', () => targetSocket.destroy())
  socket.on('end', () => targetSocket.destroy())
  socket.on('close', () => targetSocket.destroy())
}

function requestForTarget(
  target: URL,
  options: { method?: string; headers: http.OutgoingHttpHeaders }
): http.ClientRequest {
  const requestOptions = {
    protocol: target.protocol,
    hostname: connectableLoopbackHost(target.hostname),
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: options.method,
    headers: options.headers
  }
  return target.protocol === 'https:' ? https.request(requestOptions) : http.request(requestOptions)
}

function targetUrlForRequest(target: URL, request: IncomingMessage): URL {
  const url = new URL(target.toString())
  const incomingUrl = new URL(request.url || '/', target)
  url.pathname = incomingUrl.pathname
  url.search = incomingUrl.search
  return url
}

function requestHeadersForTarget(
  request: IncomingMessage,
  target: URL,
  stripCookies?: readonly string[]
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...request.headers }
  headers.host = target.host
  if (stripCookies?.length && typeof headers.cookie === 'string') {
    // Why: the proxy's own auth cookie gates every workspace behind this
    // listener. Handing it to a dev server would let anything running in one
    // workspace — a framework overlay, a logging middleware, a dependency —
    // read the credential for all the others.
    const kept = headers.cookie
      .split(';')
      .filter((part) => !stripCookies.includes(part.split('=')[0]?.trim() ?? ''))
      .join('; ')
      .trim()
    if (kept) {
      headers.cookie = kept
    } else {
      delete headers.cookie
    }
  }
  return headers
}
