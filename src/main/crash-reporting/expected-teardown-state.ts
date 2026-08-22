import { performance } from 'node:perf_hooks'
import type { ExpectedTeardownScope } from './process-gone-classification'

// Why: 5s bounds harm; Restart Manager may wait 30s, so later kills remain reportable.
export const WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS = 5_000

type Clock = () => number

// Windows performance.now is monotonic and includes time spent suspended.
const monotonicNow = (): number => performance.now()
let now: Clock = monotonicNow
let systemSessionEndedAt: number | null = null

export function markSystemSessionEnding(): void {
  systemSessionEndedAt = now()
}

function isRecentSystemSessionEnd(): boolean {
  if (systemSessionEndedAt === null) {
    return false
  }
  const elapsed = now() - systemSessionEndedAt
  if (elapsed < 0) {
    systemSessionEndedAt = null
    return false
  }
  if (elapsed >= WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS) {
    systemSessionEndedAt = null
    return false
  }
  return true
}

export function resolveExpectedTeardownScope({
  isQuitting,
  isQuittingForUpdate,
  isExpectedRendererReload,
  includeSystemSessionEnd = true
}: {
  isQuitting: boolean
  isQuittingForUpdate: boolean
  isExpectedRendererReload: boolean
  includeSystemSessionEnd?: boolean
}): ExpectedTeardownScope {
  if (
    isQuitting ||
    isQuittingForUpdate ||
    (includeSystemSessionEnd && isRecentSystemSessionEnd())
  ) {
    return 'app-shutdown'
  }
  return isExpectedRendererReload ? 'renderer-reload' : 'none'
}

export function resetExpectedTeardownStateForTest(clock: Clock = monotonicNow): void {
  now = clock
  systemSessionEndedAt = null
}
