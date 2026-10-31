import { homedir } from 'node:os'
import { getGrokHome, readGrokAuthSession, type GrokAuthReadResult } from './grok-auth'
import { grokAccessTokenNeedsCliRefresh } from './grok-auth-expiry'
import { noteGrokAuthForScheduledRefresh } from './grok-token-refresh-schedule'

// `sessions list` lets the CLI refresh near-expiry auth without sending a chat.
const GROK_SESSIONS_LIST_ARGS = ['sessions', 'list'] as const
const GROK_SESSIONS_LIST_TIMEOUT_MS = 20_000
const GROK_SESSIONS_LIST_MAX_OUTPUT_BYTES = 64 * 1024
// Stay under the schedule's one-minute retry so a failed refresh can run again.
const MIN_REFRESH_INTERVAL_MS = 50_000

export type GrokUsageAuthOptions = {
  signal?: AbortSignal
  authReadResult?: GrokAuthReadResult
}

let inFlight: Promise<void> | null = null
let lastStartedAt = Number.NEGATIVE_INFINITY

export function resetGrokSessionRefreshForTests(): void {
  inFlight = null
  lastStartedAt = Number.NEGATIVE_INFINITY
}

export async function refreshGrokAccessTokenViaSessionsList(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return
  }
  if (inFlight) {
    return inFlight
  }
  const now = Date.now()
  if (now - lastStartedAt < MIN_REFRESH_INTERVAL_MS) {
    return
  }
  lastStartedAt = now
  inFlight = runGrokSessionsList(signal).finally(() => {
    inFlight = null
  })
  return inFlight
}

export async function readGrokAuthForUsage(
  options: GrokUsageAuthOptions = {}
): Promise<GrokAuthReadResult> {
  let readResult = options.authReadResult ?? readGrokAuthSession()
  let attempted = false
  if (
    readResult.status === 'ok' &&
    grokAccessTokenNeedsCliRefresh(readResult.session.expiresAtMs) &&
    !options.signal?.aborted
  ) {
    attempted = true
    await refreshGrokAccessTokenViaSessionsList(options.signal)
    readResult = readGrokAuthSession()
  }
  noteGrokAuthForScheduledRefresh(
    readResult,
    attempted &&
      readResult.status === 'ok' &&
      grokAccessTokenNeedsCliRefresh(readResult.session.expiresAtMs)
  )
  return readResult
}

async function runGrokSessionsList(signal?: AbortSignal): Promise<void> {
  try {
    const { hostShellEnvironment } = await import('../runtime/structured-agent-shell-environment')
    // Pin the same normalized auth home as the reader, including its default.
    const env = { ...(await hostShellEnvironment()), GROK_HOME: getGrokHome() }
    const { resolveCommandOnLocalPath } = await import('../ipc/command-path-resolver')
    const program = await resolveCommandOnLocalPath('grok', { env })
    if (!program) {
      return
    }
    const { runProcess } = await import('@orca/process-host')
    await runProcess({
      program,
      args: GROK_SESSIONS_LIST_ARGS,
      env,
      cwd: homedir(),
      timeoutMs: GROK_SESSIONS_LIST_TIMEOUT_MS,
      maxOutputBytes: GROK_SESSIONS_LIST_MAX_OUTPUT_BYTES,
      signal
    })
  } catch {
    // Auth-file state determines usability and scheduled retries even when the CLI fails.
  }
}
