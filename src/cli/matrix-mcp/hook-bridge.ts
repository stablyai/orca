// Bridges the stdio MCP server (spawned by the coding agent) back into Orca's
// main process. The MCP child inherits the agent's env — which the pty spawn
// path injected with ORCA_PANE_KEY plus the agent-hooks loopback coordinates
// (ORCA_AGENT_HOOK_PORT / ORCA_AGENT_HOOK_TOKEN). So the bridge self-scopes:
// no per-session config, just read env and call the loopback hook server.

import { readFileSync } from 'fs'

const HOOK_TOKEN_HEADER = 'x-orca-agent-hook-token'
// Why: loopback calls to the same machine are sub-millisecond; a short ceiling
// keeps a wedged main process from hanging the agent's tool call indefinitely.
const HOOK_REQUEST_TIMEOUT_MS = 5_000

export type OrcaSessionEnv = {
  paneKey: string
  hookPort: string
  hookToken: string
}

export type SendResult = { ok: true; handle: string } | { ok: false; error: string }

export type AskResult =
  | { ok: true; answered: true; answer: string; handle?: string }
  | { ok: true; answered: false; reason: 'timeout' | 'superseded'; handle?: string }
  | { ok: false; error: string }

// Buffer added to the agent-side fetch timeout on top of the requested ask
// timeout, so the client keeps waiting until the server returns its (possibly
// timeout) response rather than aborting first.
const ASK_CLIENT_BUFFER_MS = 15_000

export type SessionInfo = {
  handle: string | null
  roomId: string | null
  enabled: boolean
}

// Resolves the inherited Orca session coordinates, or a clear "not in an Orca
// session" error. Loud (returned to the agent), never silent — a missing pane
// key or hook env means the tool was invoked outside an Orca session.
// The agent-hooks server keeps ORCA_AGENT_HOOK_ENDPOINT — a small KEY=value file
// — current across Orca restarts (new random port + rotated token each start),
// which the static ORCA_AGENT_HOOK_PORT/TOKEN env vars captured at agent launch
// do NOT track. Read the file first so a long-lived agent session keeps hitting
// the live hook server instead of a dead port with a stale token.
// Returns the port+token as an all-or-nothing PAIR (or null). Never mix a live
// port with a stale token: they authenticate together, so a partial file must
// fall back to the env pair wholesale rather than splicing sources.
function readEndpointFile(env: NodeJS.ProcessEnv): { port: string; token: string } | null {
  const path = env.ORCA_AGENT_HOOK_ENDPOINT?.trim()
  if (!path) {
    return null
  }
  let port: string | undefined
  let token: string | undefined
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      const eq = line.indexOf('=')
      if (eq === -1) {
        continue
      }
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim()
      if (key === 'ORCA_AGENT_HOOK_PORT') {
        port = value
      } else if (key === 'ORCA_AGENT_HOOK_TOKEN') {
        token = value
      }
    }
  } catch (error) {
    // A missing file is the expected case (older session / file not yet written)
    // and just falls back to env. Any OTHER read error is unexpected — surface it
    // loudly rather than silently degrading to a possibly-stale env.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[matrix] failed to read hook endpoint file ${path}: ${String(error)}`)
    }
    return null
  }
  return port && token ? { port, token } : null
}

export function resolveSessionEnv(
  env: NodeJS.ProcessEnv = process.env
): { ok: true; env: OrcaSessionEnv } | { ok: false; error: string } {
  const paneKey = env.ORCA_PANE_KEY?.trim()
  // Prefer the server-maintained endpoint file (current port+token as a pair);
  // fall back to the static env pair when the file is absent/unreadable/partial.
  const live = readEndpointFile(env)
  const hookPort = live?.port ?? env.ORCA_AGENT_HOOK_PORT?.trim()
  const hookToken = live?.token ?? env.ORCA_AGENT_HOOK_TOKEN?.trim()
  if (!paneKey || !hookPort || !hookToken) {
    return {
      ok: false,
      error:
        'Not in an Orca session: ORCA_PANE_KEY / ORCA_AGENT_HOOK_PORT / ' +
        'ORCA_AGENT_HOOK_TOKEN are not set. This tool only works inside an Orca session.'
    }
  }
  return { ok: true, env: { paneKey, hookPort, hookToken } }
}

function hookUrl(session: OrcaSessionEnv, path: string): string {
  return `http://127.0.0.1:${session.hookPort}${path}`
}

async function fetchHook(
  session: OrcaSessionEnv,
  path: string,
  init: { method: 'GET' | 'POST'; body?: string; timeoutMs?: number }
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? HOOK_REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(hookUrl(session, path), {
      method: init.method,
      headers: {
        [HOOK_TOKEN_HEADER]: session.hookToken,
        ...(init.body ? { 'content-type': 'application/json' } : {})
      },
      ...(init.body ? { body: init.body } : {}),
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`Orca hook server returned ${response.status}`)
    }
    return (await response.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return 'Timed out contacting the Orca hook server.'
    }
    return error.message
  }
  return String(error)
}

// POSTs the message to the Orca hook server, which tags it with this session's
// handle and relays it to the operator's Matrix room.
export async function sendMatrixMessage(
  session: OrcaSessionEnv,
  message: string
): Promise<SendResult> {
  try {
    const result = await fetchHook(session, '/matrix/send', {
      method: 'POST',
      body: JSON.stringify({ paneKey: session.paneKey, message })
    })
    const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
    if (record.ok === true && typeof record.handle === 'string') {
      return { ok: true, handle: record.handle }
    }
    const error = typeof record.error === 'string' ? record.error : 'Failed to send Matrix message.'
    return { ok: false, error }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

// Asks the operator a question in the Matrix room and BLOCKS until they reply or
// the server-side ask timeout fires. The client fetch timeout sits above the ask
// timeout (plus a buffer) so it waits for the server's response — including the
// "answered:false, timeout" outcome — rather than aborting the held request.
export async function askOperator(
  session: OrcaSessionEnv,
  question: string,
  timeoutMs: number
): Promise<AskResult> {
  try {
    const result = await fetchHook(session, '/matrix/ask', {
      method: 'POST',
      body: JSON.stringify({ paneKey: session.paneKey, question, timeoutMs }),
      timeoutMs: timeoutMs + ASK_CLIENT_BUFFER_MS
    })
    const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
    const handle = typeof record.handle === 'string' ? record.handle : undefined
    if (record.ok === true) {
      if (record.answered === true && typeof record.answer === 'string') {
        return { ok: true, answered: true, answer: record.answer, handle }
      }
      const reason = record.reason === 'superseded' ? 'superseded' : 'timeout'
      return { ok: true, answered: false, reason, handle }
    }
    const error = typeof record.error === 'string' ? record.error : 'Failed to ask the operator.'
    return { ok: false, error }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

// Fetches this session's Matrix handle, the target room id, and whether the
// adapter is enabled so the agent can tell the operator how to reply.
export async function fetchSessionInfo(
  session: OrcaSessionEnv
): Promise<{ ok: true; info: SessionInfo } | { ok: false; error: string }> {
  try {
    const query = `?paneKey=${encodeURIComponent(session.paneKey)}`
    const result = await fetchHook(session, `/matrix/session-info${query}`, { method: 'GET' })
    const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
    return {
      ok: true,
      info: {
        handle: typeof record.handle === 'string' ? record.handle : null,
        roomId: typeof record.roomId === 'string' ? record.roomId : null,
        enabled: record.enabled === true
      }
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}
