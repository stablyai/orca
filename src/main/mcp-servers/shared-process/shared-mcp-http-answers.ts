// What a shared server's relay address answers itself, in the shapes the SDK's own HTTP servers use.
import type { ServerResponse } from 'node:http'

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: '2.0',
  id: null,
  error: { code, message }
})

function answer(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(jsonRpcError(code, message)))
}

/** Anything but initialize without a session (an agent's `server/discover` probe, say), which
 *  agents take as "initialize first". */
export function answerNoSession(res: ServerResponse): void {
  answer(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required')
}

/** Streamable HTTP's "start a new session" answer. */
export function answerSessionGone(res: ServerResponse): void {
  answer(res, 404, -32001, 'Session not found')
}

export function answerParseError(res: ServerResponse): void {
  answer(res, 400, -32700, 'Parse error')
}
