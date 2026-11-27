// One call's trip to the tool's server: every agent header but its relay credentials goes along,
// a deadline for the server's response headers, and the response streamed back at the agent's pace.
import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BotToolCredentialAnswer } from '../tool-oauth/bot-tool-credential-source'
import { header, RelayRefusal } from './bot-tool-relay-requests'

export type RelayFetch = (url: string, init: RequestInit) => Promise<Response>
export type ReadyAnswer = Extract<BotToolCredentialAnswer, { kind: 'ready' }>

/** A tool call may think for minutes before its first byte; anything else answers or streams soon. */
const POST_HEADERS_DEADLINE_MS = 5 * 60_000
const OTHER_HEADERS_DEADLINE_MS = 30_000
const HEADERS_LATE = Symbol('headers late')
// Belong to one connection, not the request; RFC 9110 §7.6.1.
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]
// fetch sets these itself; authorization and cookie are the agent's credentials for the relay.
const DROPPED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'host',
  'content-length',
  'expect',
  'accept-encoding',
  'authorization',
  'cookie'
])
// fetch already decoded the body; www-authenticate would start a sign-in against the relay.
const DROPPED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-length',
  'content-encoding',
  'www-authenticate'
])

/** Sends the call with the credential's headers; the 504 deadline covers only the wait for headers. */
export async function sendUpstream(
  fetchUpstream: RelayFetch,
  req: IncomingMessage,
  answer: ReadyAnswer,
  body: Buffer | undefined,
  signal: AbortSignal
): Promise<Response> {
  const headers: Record<string, string> = {}
  const named = connectionHeaders(header(req, 'connection'))
  // Saved headers win whatever their case; fetch would otherwise join both values.
  const saved = new Set(Object.keys(answer.headers).map((name) => name.toLowerCase()))
  for (const name of Object.keys(req.headers)) {
    const value = header(req, name)
    if (
      value !== undefined &&
      !DROPPED_REQUEST_HEADERS.has(name) &&
      !name.startsWith('proxy-') &&
      !named.has(name) &&
      !saved.has(name)
    ) {
      headers[name] = value
    }
  }
  const deadline = new AbortController()
  const timer = setTimeout(
    () => deadline.abort(HEADERS_LATE),
    req.method === 'POST' ? POST_HEADERS_DEADLINE_MS : OTHER_HEADERS_DEADLINE_MS
  )
  try {
    // Bounds the wait for headers only; the timer is cleared before any of the body is read.
    return await fetchUpstream(answer.url, {
      method: req.method,
      headers: { ...headers, ...answer.headers },
      ...(body ? { body: new Uint8Array(body) } : {}),
      // fetch keeps custom headers across a redirect to another host, so none is followed.
      redirect: 'manual',
      signal: AbortSignal.any([signal, deadline.signal])
    })
  } catch (error) {
    if (deadline.signal.aborted && !signal.aborted) {
      throw new RelayRefusal(504, 'The tool’s server didn’t answer in time.')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Sends the response's headers at once, then its body as fast as the agent takes it. */
export async function streamUpstreamResponse(
  res: ServerResponse,
  upstream: Response,
  signal: AbortSignal
): Promise<void> {
  const out: Record<string, string | string[]> = {}
  const named = connectionHeaders(upstream.headers.get('connection') ?? undefined)
  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name) && !name.startsWith('proxy-') && !named.has(name)) {
      out[name] = name === 'set-cookie' ? upstream.headers.getSetCookie() : value
    }
  })
  // A refusal is passed on as 403 so neither CLI starts a sign-in against the relay.
  res.writeHead(upstream.status === 401 ? 403 : upstream.status, out)
  // Sent now, so an event stream that stays quiet still reaches the agent as open.
  res.flushHeaders()
  if (!upstream.body) {
    res.end()
    return
  }
  // Reads the next chunk only once the agent has taken the last one.
  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (!res.write(value)) {
        await once(res, 'drain', { signal })
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  res.end()
}

/** Headers a Connection header names are hop-by-hop too. */
function connectionHeaders(connection: string | undefined): Set<string> {
  return new Set(
    (connection ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  )
}

/** Why the tool's server refused, for the Tools row. */
export function refusalProblem(upstream: Response, answer: ReadyAnswer): string {
  if (answer.bearer === undefined) {
    return 'The tool’s server refused its saved values.'
  }
  // A 403 is about permission, not an expired token, so it's never refreshed.
  return /error="?insufficient_scope/.test(upstream.headers.get('www-authenticate') ?? '')
    ? 'The app needs more access than this sign-in allows.'
    : 'The app refused this with the current sign-in.'
}
