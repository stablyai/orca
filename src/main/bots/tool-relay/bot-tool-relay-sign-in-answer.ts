// What the relay answers, under each request's id, when a tool can't be called now: it has no
// sign-in a call can use, or its key or token server isn't there. Never a 401: either agent would
// then start its own sign-in against the relay.
import type { IncomingMessage, ServerResponse } from 'node:http'

/** The JSON-RPC error code MCP clients read as "this server needs authorization". */
const SIGN_IN_NEEDED_CODE = -32001
/** Also how the tray knows an Orca server failed only for want of Orca's sign-in. */
export const SIGN_IN_NEEDED = 'Sign in to this app in Orca to use it.'
/** A JSON-RPC server error: the call didn't reach the tool, and may work if tried again. */
const UNAVAILABLE_CODE = -32000
const UNAVAILABLE = 'This tool can’t be used from this computer right now. Try again later.'

type JsonRpcId = string | number | null

/** The ids of the requests in a JSON-RPC body; notifications and responses carry none we answer. */
function requestIds(message: unknown): JsonRpcId[] {
  const messages = Array.isArray(message) ? message : [message]
  return messages.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || !('method' in entry) || !('id' in entry)) {
      return []
    }
    const { id } = entry
    return typeof id === 'string' || typeof id === 'number' ? [id] : []
  })
}

const errorFor = (id: JsonRpcId, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message }
})

/** The body's JSON-RPC message, or undefined when it isn't JSON. */
function parsed(body: Buffer | undefined): unknown {
  try {
    return JSON.parse(body?.toString('utf8') ?? '')
  } catch {
    return undefined
  }
}

/** One error per request in `message` under its id, as one object or a batch like the request. */
function errorsFor(message: unknown, code: number, text: string): unknown {
  const errors = requestIds(message).map((id) => errorFor(id, code, text))
  return errors.length === 0 ? null : Array.isArray(message) ? errors : errors[0]
}

/**
 * Answers each request in the body with a "sign in" error under its own id, so the agent shows it
 * for that call; a body of notifications alone gets 202, and GET or DELETE gets 405.
 */
export function answerSignInNeeded(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer | undefined
): void {
  answerEachRequest(req, res, body, SIGN_IN_NEEDED_CODE, SIGN_IN_NEEDED)
}

/** What a call to a tool its folder doesn't name, or whose saved entry won't open here, is told. */
const MISSING = {
  bot: 'This bot has no such tool.',
  host: 'Orca’s MCP servers no longer include this server. Your next message picks up the change.'
} as const
const UNREADABLE =
  'Orca can’t open this server’s saved sign-in or key on this computer. Sign in again, or enter its key again, in Orca’s MCP servers settings.'

/**
 * A tool its folder no longer names gets a 404, as before. A host-list server whose saved entry
 * won't open here is answered per request, as a sign-in is, so the agent shows why and its
 * Settings row offers Sign in again.
 */
export function answerToolGone(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer | undefined,
  scope: 'bot' | 'host',
  kind: 'missing' | 'unreadable'
): void {
  // A bot's Tools rows can't sign in over such an entry: it reads as missing there, as it always has.
  if (kind === 'unreadable' && scope === 'host') {
    answerEachRequest(req, res, body, UNAVAILABLE_CODE, UNREADABLE)
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: MISSING[scope] }))
}

function answerEachRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer | undefined,
  code: number,
  text: string
): void {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
    res.end(JSON.stringify({ error: text }))
    return
  }
  const message = parsed(body)
  if (message === undefined) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify(errorFor(null, -32700, 'Parse error')))
    return
  }
  const errors = errorsFor(message, code, text)
  if (!errors) {
    res.writeHead(202)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(errors))
}

/**
 * A 502 as before, whose body names each request's id so the agent ties the failure to that call;
 * anything else gets the plain error.
 */
export function answerUnavailable(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer | undefined
): void {
  const errors =
    req.method === 'POST' ? errorsFor(parsed(body), UNAVAILABLE_CODE, UNAVAILABLE) : null
  res.writeHead(502, { 'content-type': 'application/json' })
  res.end(JSON.stringify(errors ?? { error: UNAVAILABLE }))
}
