import { homedir } from 'node:os'
import { sharedPromiseSettlementWaiters } from '../../../../shared/promise-settlement-waiters'
import { getGrokHome, readGrokAuthSession, type GrokAuthReadResult } from './grok-auth'
import { grokAccessTokenNeedsCliRefresh } from './grok-auth-expiry'
import { noteGrokAuthForScheduledRefresh } from './grok-token-refresh-schedule'

// `sessions list` lets the CLI refresh near-expiry auth without sending a chat.
const GROK_SESSIONS_LIST_ARGS = ['sessions', 'list'] as const
const GROK_SESSIONS_LIST_SETUP_TIMEOUT_MS = 10_000
const GROK_SESSIONS_LIST_TIMEOUT_MS = 20_000
const GROK_SESSIONS_LIST_MAX_OUTPUT_BYTES = 64 * 1024
// Stay under the schedule's one-minute retry so a failed refresh can run again.
const MIN_REFRESH_INTERVAL_MS = 50_000

export type GrokUsageAuthOptions = {
  signal?: AbortSignal
  authReadResult?: GrokAuthReadResult
}

type GrokRefreshAttempt =
  | { kind: 'attempted' }
  | { kind: 'skipped' }
  | { kind: 'debounced'; retryAfterMs: number }

let inFlight: Promise<void> | null = null
let lastStartedAt = Number.NEGATIVE_INFINITY

export function resetGrokSessionRefreshForTests(): void {
  inFlight = null
  lastStartedAt = Number.NEGATIVE_INFINITY
}

export async function refreshGrokAccessTokenViaSessionsList(
  signal?: AbortSignal
): Promise<GrokRefreshAttempt> {
  if (signal?.aborted) {
    return { kind: 'skipped' }
  }
  if (inFlight) {
    await inFlight
    return { kind: 'skipped' }
  }
  const now = Date.now()
  const retryAfterMs = lastStartedAt + MIN_REFRESH_INTERVAL_MS - now
  if (retryAfterMs > 0) {
    return { kind: 'debounced', retryAfterMs }
  }
  lastStartedAt = now
  inFlight = runGrokSessionsList(signal).finally(() => {
    inFlight = null
  })
  await inFlight
  return { kind: 'attempted' }
}

export async function readGrokAuthForUsage(
  options: GrokUsageAuthOptions = {}
): Promise<GrokAuthReadResult> {
  const readResult = options.authReadResult ?? readGrokAuthSession()
  if (
    readResult.status !== 'ok' ||
    !grokAccessTokenNeedsCliRefresh(readResult.session.expiresAtMs)
  ) {
    noteGrokAuthForScheduledRefresh(readResult, false)
    return readResult
  }
  if (options.signal?.aborted) {
    return readResult
  }
  const attempt = await refreshGrokAccessTokenViaSessionsList(options.signal)
  const refreshed = readGrokAuthSession()
  if (attempt.kind !== 'skipped') {
    noteGrokAuthForScheduledRefresh(
      refreshed,
      attempt.kind === 'attempted',
      attempt.kind === 'debounced' ? attempt.retryAfterMs : 0
    )
  }
  return refreshed
}

async function runGrokSessionsList(signal?: AbortSignal): Promise<void> {
  try {
    // Filesystem lookup cannot be cancelled; only a timely setup may spawn the CLI.
    const prepared = await sharedPromiseSettlementWaiters(prepareGrokSessionsList()).wait({
      signal,
      timeoutMs: GROK_SESSIONS_LIST_SETUP_TIMEOUT_MS
    })
    if (!prepared || signal?.aborted) {
      return
    }
    const { program, env, runProcess } = prepared
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

async function prepareGrokSessionsList() {
  const { hostShellEnvironment } =
    await import('../../../runtime/agent-session/environment/structured-agent-shell-environment')
  // Pin the same normalized auth home as the reader, including its default.
  const env = { ...(await hostShellEnvironment()), GROK_HOME: getGrokHome() }
  const { resolveCommandOnLocalPath } =
    await import('../../../ipc/command-path/command-path-resolver')
  const program = await resolveCommandOnLocalPath('grok', { env })
  if (!program) {
    return null
  }
  const { runProcess } = await import('@orca/process-host')
  return { program, env, runProcess }
}
