import { parseRemoteCliArgs } from './ssh-remote-cli-args'
import { clampOrchestrationAskTimeoutMs } from '../../shared/orchestration-ask-timeout'
import {
  isSafeTimerDelayMs,
  parsePositiveSafeIntegerNumericText,
  parsePositiveSafeIntegerText
} from '../../shared/timer-delay'

const DEFAULT_KILL_TIMEOUT_MS = 10 * 60_000
const KILL_TIMEOUT_GRACE_MS = 2 * 60_000

/** Kill timer for the host CLI subprocess. Long-poll commands carry their wait
 * budget in `--timeout-ms`; extend past it so the CLI's own timeout fires
 * first and produces a proper error message. */
export function resolveHostCliKillTimeoutMs(argv: string[]): number {
  const parsed = parseRemoteCliArgs(argv)
  const rawTimeout = parsed.flags.get('timeout-ms')
  if (parsed.commandPath[0] === 'terminal' && parsed.commandPath[1] === 'send') {
    const rawWait = parsed.flags.get('wait-submit')
    const seconds =
      typeof rawWait === 'string' ? parsePositiveSafeIntegerNumericText(rawWait) : null
    if (seconds !== null && seconds <= 3600) {
      return Math.max(DEFAULT_KILL_TIMEOUT_MS, seconds * 1000 + KILL_TIMEOUT_GRACE_MS)
    }
  }
  if (parsed.commandPath[0] === 'orchestration' && parsed.commandPath[1] === 'ask') {
    const explicit =
      typeof rawTimeout === 'string' ? parsePositiveSafeIntegerText(rawTimeout) : null
    return Math.max(
      DEFAULT_KILL_TIMEOUT_MS,
      clampOrchestrationAskTimeoutMs(explicit ?? undefined) + KILL_TIMEOUT_GRACE_MS
    )
  }
  const explicit =
    typeof rawTimeout === 'string' ? parsePositiveSafeIntegerNumericText(rawTimeout) : null
  // Why: this feeds the kill timer directly, so a post-grace budget outside the
  // timer range degrades to the default instead of throwing at spawn time.
  const extended = explicit === null ? null : explicit + KILL_TIMEOUT_GRACE_MS
  if (extended !== null && isSafeTimerDelayMs(extended)) {
    return Math.max(DEFAULT_KILL_TIMEOUT_MS, extended)
  }
  return DEFAULT_KILL_TIMEOUT_MS
}
