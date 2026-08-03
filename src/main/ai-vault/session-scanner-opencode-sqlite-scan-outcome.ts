import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { ActiveSpan } from '../observability/tracer'
import { looksLikeOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import type {
  OpenCodeSqliteScanContext,
  OpenCodeSqliteScanMetrics
} from './session-scanner-opencode-sqlite-scan-context'
import {
  noteOpenCodeSqliteScanHardFailure,
  noteOpenCodeSqliteScanProgress
} from './session-scanner-opencode-sqlite-scan-cooldown'
import type { SessionFileCandidate, SessionFileDiscovery } from './session-scanner-types'

export function recordOpenCodeSqliteScanOutcome(args: {
  candidates: readonly SessionFileCandidate[]
  context: OpenCodeSqliteScanContext
  discoveries: readonly SessionFileDiscovery[]
  issues: AiVaultScanIssue[]
  span: ActiveSpan
}): void {
  const metrics = args.context.metrics()
  args.span.setAttribute('opencodeSqliteDeadlineExpired', metrics.deadlineExpired)
  args.span.setAttribute('opencodeSqliteQueueWaitMs', metrics.queueWaitMs)
  args.span.setAttribute('opencodeSqliteActiveWorkerMs', metrics.activeWorkerMs)
  args.span.setAttribute(
    'opencodeSqliteSources',
    args.discoveries.filter((discovery) => discovery.agent === 'opencode').length
  )
  args.span.setAttribute(
    'opencodeSqliteCandidates',
    args.candidates.filter((candidate) => looksLikeOpenCodeSqliteCandidate(candidate.file.path))
      .length
  )
  args.span.setAttribute('opencodeSqliteListCancelled', metrics.sqliteListCancelled)
  args.span.setAttribute('opencodeSqliteParseCacheHits', metrics.sqliteParseCacheHits)
  args.span.setAttribute('opencodeSqliteTerminationReason', metrics.terminationReason ?? 'none')
  const message = scanOutcomeMessage(metrics)
  if (message) {
    args.issues.push({ agent: 'opencode', path: 'opencode.db', message })
  }
  // A list response caches nothing. A completed parse or a cache-served row
  // proves the user-visible scan still made progress.
  if (
    metrics.terminationReason === 'deadline' &&
    !metrics.parseAnswered &&
    metrics.sqliteParseCacheHits === 0
  ) {
    noteOpenCodeSqliteScanHardFailure()
    return
  }
  // Only a scan that got through its SQLite work clears the process-wide
  // backoff; a scan that never had any to do says nothing either way.
  if (metrics.sqliteSourcePresent && metrics.terminationReason === null && !metrics.workOmitted) {
    noteOpenCodeSqliteScanProgress()
  }
}

// Why: crash loops, timeout loops, and cooldown are not budget exhaustion;
// reporting them all as "budget ended" sends operators after the wrong cause.
// The termination reason leads because it is the actionable half — an
// unreconciled listing is a consequence of it, not a competing explanation.
function scanOutcomeMessage(metrics: OpenCodeSqliteScanMetrics): string | null {
  const cause = terminationCauseMessage(metrics)
  if (cause && metrics.sqliteListCancelled) {
    return `${cause} Its SQLite database was never checked, so some sessions may also be missing or out of date.`
  }
  if (cause) {
    return cause
  }
  if (metrics.sqliteListCancelled) {
    return 'OpenCode history could not be checked against its SQLite database, so some sessions may be missing or out of date.'
  }
  return null
}

function terminationCauseMessage(metrics: OpenCodeSqliteScanMetrics): string | null {
  // Cooldown is worth reporting even with nothing omitted: it explains why the
  // SQLite half of the listing is absent this time round. But only to someone
  // who has an OpenCode database — a backoff outliving the install it came from
  // must not surface an OpenCode error on a machine with no OpenCode.
  if (metrics.terminationReason === 'cooldown') {
    return metrics.sqliteSourcePresent
      ? 'OpenCode history was not scanned this time; its background scanner is paused after repeated failures and will be retried automatically.'
      : null
  }
  if (!metrics.workOmitted) {
    return null
  }
  switch (metrics.terminationReason) {
    case 'deadline':
      return 'Some OpenCode history was skipped after its SQLite scan budget ended.'
    case 'workerCrashLoop':
      return 'Some OpenCode history was skipped because its background scanner kept crashing.'
    case 'workerTimeoutLoop':
      return 'Some OpenCode history was skipped because its SQLite database was too slow to read.'
    case 'workerUnavailable':
      return 'Some OpenCode history was skipped because its background scanner could not start.'
    case 'listFailed':
      return 'Some OpenCode history was skipped because its SQLite session listing failed.'
    // 'cooldown' returned above, so it is already narrowed out here.
    case 'scanEnded':
    case null:
      return 'Some OpenCode history was skipped because the scan ended before it finished.'
  }
}
