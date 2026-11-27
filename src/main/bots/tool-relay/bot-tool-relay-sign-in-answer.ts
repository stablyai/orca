// What the relay answers, under each request's id, when a tool can't be called now: it has no
// sign-in a call can use, or its key or token server isn't there. Never a 401: either agent would
// then start its own sign-in against the relay.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody } from './bot-tool-relay-requests'

/** The JSON-RPC error code MCP clients read as "this server needs authorization". */
const SIGN_IN_NEEDED_CODE = -32001
const SIGN_IN_NEEDED = 'Sign in to this app in Orca to use it.'
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
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
    res.end(JSON.stringify({ error: SIGN_IN_NEEDED }))
    return
  }
  const message = parsed(body)
  if (message === undefined) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify(errorFor(null, -32700, 'Parse error')))
    return
  }
  const errors = errorsFor(message, SIGN_IN_NEEDED_CODE, SIGN_IN_NEEDED)
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

/**
 * A kept bot token the keychain won't open. On Linux the keyring a run of Orca started locked stays
 * unreadable to it after an unlock (its key is chosen at startup), so only a restart of Orca helps.
 */
export const CREDENTIALS_LOCKED =
  process.platform === 'linux'
    ? "Orca can't unlock this bot's credentials (the keyring is locked). Ask the user to unlock the keyring and restart Orca. Your session is still running."
    : "Orca can't unlock this bot's credentials yet (the keychain is locked). Your session is still running; try again shortly."
/** Only a body this small is read for its ids; anything else is answered without one. */
const LOCKED_ID_READ_MAX_BYTES = 64 * 1024

/**
 * A kept agent's call while the keychain won't open its bot's token: a 503 that says to try again,
 * under the request's id when the body is small enough to read cheaply.
 */
export async function answerCredentialsLocked(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const length = Number(req.headers['content-length'])
  const small = req.method === 'POST' && length > 0 && length <= LOCKED_ID_READ_MAX_BYTES
  const body = small ? await readBody(req).catch(() => undefined) : undefined
  const errors = body ? errorsFor(parsed(body), UNAVAILABLE_CODE, CREDENTIALS_LOCKED) : null
  res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' })
  res.end(JSON.stringify(errors ?? errorFor(null, UNAVAILABLE_CODE, CREDENTIALS_LOCKED)))
}
