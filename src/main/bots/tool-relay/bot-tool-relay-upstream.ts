// One call's trip to the tool's server: the agent's request headers that go along, a deadline for
// the server's response headers, and the response streamed back at the agent's pace.
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
const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id'
]
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'cache-control',
  'retry-after'
]

/** Sends the call with the credential's headers; the 504 deadline covers only the wait for headers. */
export async function sendUpstream(
  fetchUpstream: RelayFetch,
  req: IncomingMessage,
  answer: ReadyAnswer,
  body: Buffer | undefined,
  signal: AbortSignal
): Promise<Response> {
  const headers: Record<string, string> = {}
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = header(req, name)
    if (value !== undefined) {
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
  const out: Record<string, string> = {}
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value !== null) {
      out[name] = value
    }
  }
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
