import type { IncomingMessage, ServerResponse } from 'http'
import { getMatrixService } from '../matrix/matrix-service'
import { formatHandlePrefix } from '../matrix/matrix-event-format'
import { handleForPaneKey } from '../matrix/session-handle-registry'
import { registerAsk } from '../matrix/operator-ask-registry'
import { recordOutboundMessage } from '../matrix/outbound-message-session-registry'

// JSON-returning routes for the Matrix MCP bridge, extracted from server.ts so
// the loopback hook server's POST-only/204 core stays untouched and the
// agent-hooks ↔ matrix coupling lives in one focused module. The agent's
// `orca matrix-mcp` stdio server (spawned inside an Orca session) calls these
// over the loopback server using the inherited hook token.

const MATRIX_SEND_PATH = '/matrix/send'
const MATRIX_SESSION_INFO_PATH = '/matrix/session-info'
const MATRIX_ASK_PATH = '/matrix/ask'

// Bounds for the blocking ask: a floor so a too-short timeout isn't useless, and
// a 30-minute ceiling so a wedged ask can't pin a socket forever. server.ts
// derives its per-request socket timeout from this ceiling.
const ASK_TIMEOUT_MIN_MS = 5_000
const ASK_TIMEOUT_MAX_MS = 1_800_000
const ASK_TIMEOUT_DEFAULT_MS = 300_000

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function readPaneKey(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// Resolves this session's handle and the operator room without forcing a
// connection: a disabled/unconfigured adapter still answers with enabled:false
// so the agent can report the state instead of hanging.
async function handleSessionInfo(res: ServerResponse, paneKey: string | null): Promise<void> {
  const status = await getMatrixService().getStatus()
  writeJson(res, 200, {
    handle: paneKey ? handleForPaneKey(paneKey) : null,
    roomId: status.roomId ?? null,
    enabled: status.enabled === true
  })
}

// Tags the message with the session handle and relays it to the room. Returns
// the structured result loudly (never fail-open) so the MCP tool surfaces
// delivery failures to the agent.
async function handleSend(res: ServerResponse, body: unknown): Promise<void> {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const paneKey = readPaneKey(record.paneKey)
  const message = typeof record.message === 'string' ? record.message : ''
  if (!paneKey) {
    writeJson(res, 400, { ok: false, error: 'paneKey is required.' })
    return
  }
  if (!message.trim()) {
    writeJson(res, 400, { ok: false, error: 'message is required.' })
    return
  }
  const handle = handleForPaneKey(paneKey)
  const result = await getMatrixService().sendToRoom(formatHandlePrefix(handle, message))
  if (result.ok) {
    // Track this send so an operator reply to it routes back to this session.
    recordOutboundMessage(result.eventId, paneKey)
    writeJson(res, 200, { ok: true, handle })
    return
  }
  writeJson(res, 200, { ok: false, handle, error: result.error ?? 'Failed to send.' })
}

function clampTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return ASK_TIMEOUT_DEFAULT_MS
  }
  return Math.min(Math.max(Math.floor(value), ASK_TIMEOUT_MIN_MS), ASK_TIMEOUT_MAX_MS)
}

// Sends the question to the room, then blocks (registerAsk) until the inbound
// router resolves it with the operator's reply or the timeout fires. ok:true on
// timeout — the call itself succeeded, there's just no answer. A send failure is
// reported immediately without registering a waiter.
async function handleAsk(res: ServerResponse, body: unknown): Promise<void> {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const paneKey = readPaneKey(record.paneKey)
  const question = typeof record.question === 'string' ? record.question : ''
  if (!paneKey) {
    writeJson(res, 400, { ok: false, error: 'paneKey is required.' })
    return
  }
  if (!question.trim()) {
    writeJson(res, 400, { ok: false, error: 'question is required.' })
    return
  }
  const timeoutMs = clampTimeoutMs(record.timeoutMs)
  const handle = handleForPaneKey(paneKey)
  const sent = await getMatrixService().sendToRoom(formatHandlePrefix(handle, question))
  if (!sent.ok) {
    writeJson(res, 200, { ok: false, handle, error: sent.error ?? 'Failed to send.' })
    return
  }
  // Record the question's event id BEFORE registering the waiter so a reply to
  // the question resolves THIS ask (the reply path looks the ask up by paneKey).
  recordOutboundMessage(sent.eventId, paneKey)
  const outcome = await registerAsk(paneKey, timeoutMs)
  if (outcome.answered) {
    writeJson(res, 200, { ok: true, answered: true, answer: outcome.answer, handle })
    return
  }
  writeJson(res, 200, { ok: true, answered: false, reason: outcome.reason, handle })
}

// Returns true when the request was a Matrix route (and was handled), false to
// let the caller fall through to the existing hook ingest path. Callers must
// have already verified the hook token.
export async function tryHandleMatrixRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  body: unknown
): Promise<boolean> {
  if (pathname === MATRIX_SEND_PATH && req.method === 'POST') {
    await handleSend(res, body)
    return true
  }
  if (pathname === MATRIX_ASK_PATH && req.method === 'POST') {
    await handleAsk(res, body)
    return true
  }
  if (pathname === MATRIX_SESSION_INFO_PATH && req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    await handleSessionInfo(res, readPaneKey(url.searchParams.get('paneKey')))
    return true
  }
  return false
}

export {
  MATRIX_SEND_PATH,
  MATRIX_SESSION_INFO_PATH,
  MATRIX_ASK_PATH,
  ASK_TIMEOUT_MAX_MS,
  ASK_TIMEOUT_DEFAULT_MS
}
