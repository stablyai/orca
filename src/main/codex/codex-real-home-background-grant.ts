import { readHooksJsonWithRaw } from '../agent-hooks/installer-utils'
import { getRealHomeConfigTomlPath, getRealHomeHooksJsonPath } from './codex-real-home-hooks-json'
import {
  grantManagedCodexHookTrust,
  type CodexManagedTrustGrantOutcome,
  type CodexManagedTrustGrantPlan
} from './codex-hook-trust-grant'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import { readOrcaEntryTrust } from './codex-real-home-entry-trust'
import type { RealHomeCodexHookSlotWrite } from './codex-real-home-hook-entry-plan'
import { readHookTrustEntries } from './config-toml-trust'

// Why seconds: a background grant blocks no launch, and a long latch at boot
// keeps ~/.codex off its hooks long after the app-server recovers.
const CODEX_BACKGROUND_TRUST_GRANT_RETRY_INTERVAL_MS = 10_000
// Why: a host whose app-server never starts in time must not rewrite
// ~/.codex/hooks.json and start a 30 s session on every launch for good.
const TIMEOUTS_BEFORE_BACKOFF = 3
const TIMEOUT_BACKOFF_MS = [10_000, 60_000, 5 * 60_000]
// Why process-scoped, reset only by a success: app start begins at zero, so a slow boot never latches.
let consecutiveTimeouts = 0

export type RealHomeBackgroundGrant = {
  plan: CodexManagedTrustGrantPlan
  writes: readonly RealHomeCodexHookSlotWrite[]
  command: string
}

/** Codex's approval of real-home entries; null when the attempt threw. Never throws. */
export async function requestRealHomeCodexApproval(
  plan: CodexManagedTrustGrantPlan
): Promise<CodexManagedTrustGrantOutcome | null> {
  try {
    return await grantManagedCodexHookTrust(plan)
  } catch (error) {
    console.warn('[codex-real-home-hooks] background trust grant failed:', error)
    return null
  }
}

/** Records an approval's outcome and returns when the next attempt may run. */
export function recordRealHomeApprovalOutcome(
  outcome: CodexManagedTrustGrantOutcome | null
): number {
  if (outcome?.lane === 'rpc') {
    consecutiveTimeouts = 0
    return 0
  }
  if (
    outcome?.reason === 'unsupported' ||
    outcome?.reason === 'unsupported-cached' ||
    outcome?.reason === 'disabled'
  ) {
    return Number.POSITIVE_INFINITY
  }
  if (outcome?.errorClass !== 'timeout') {
    return Date.now() + CODEX_BACKGROUND_TRUST_GRANT_RETRY_INTERVAL_MS
  }
  // Why: the first slow cold starts retry on the next launch instead of latching for minutes.
  consecutiveTimeouts += 1
  if (consecutiveTimeouts < TIMEOUTS_BEFORE_BACKOFF) {
    return 0
  }
  const step = Math.min(
    consecutiveTimeouts - TIMEOUTS_BEFORE_BACKOFF,
    TIMEOUT_BACKOFF_MS.length - 1
  )
  return Date.now() + TIMEOUT_BACKOFF_MS[step]
}

export function describeRealHomeApprovalRetry(retryAfterMs: number): string {
  if (retryAfterMs === Number.POSITIVE_INFINITY) {
    return 'not retrying'
  }
  const delayMs = retryAfterMs - Date.now()
  return delayMs > 0 ? `retrying in ${Math.ceil(delayMs / 1000)} s` : 'retrying on the next launch'
}

/**
 * Whether ~/.codex holds an entry with `command` that Codex would put up for
 * review. An unreadable file reads as yes: the caller's wait is bounded.
 */
export function hasUnapprovedRealHomeOrcaEntry(command: string): boolean {
  try {
    const hooksJsonPath = getRealHomeHooksJsonPath()
    const { config } = readHooksJsonWithRaw(hooksJsonPath)
    const trustStates = readHookTrustEntries(getRealHomeConfigTomlPath())
    return Object.entries(config?.hooks ?? {}).some(
      ([eventName, definitions]) =>
        Array.isArray(definitions) &&
        definitions.some(
          (definition, groupIndex) =>
            Array.isArray(definition.hooks) &&
            definition.hooks.some((hook, handlerIndex) => {
              if (hook.command !== command) {
                return false
              }
              const entry = createCodexHookTrustEntry(
                hooksJsonPath,
                eventName,
                groupIndex,
                handlerIndex,
                definition,
                hook
              )
              const trust = entry ? readOrcaEntryTrust(entry, trustStates) : 'untrusted'
              return trust === 'untrusted' || trust === 'stale'
            })
        )
    )
  } catch (error) {
    console.warn('[codex-real-home-hooks] could not read Orca entry approval:', error)
    return true
  }
}

export const _internals = {
  resetTimeoutStreakForTesting(): void {
    consecutiveTimeouts = 0
  }
}
