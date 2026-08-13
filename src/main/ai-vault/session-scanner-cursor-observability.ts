import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { CursorSidecarScanResponse } from '../../shared/cursor-sidecar-scan'
import type { ActiveSpan } from '../observability/tracer'
import type {
  CursorReconcileStats,
  ParsedCursorCandidate
} from './session-scanner-cursor-reconcile'
import type { SessionFileDiscovery } from './session-scanner-types'

export function recordCursorScanSpan(args: {
  span: ActiveSpan
  sidecarCandidatePaths: readonly string[]
  parsedCandidates: readonly ParsedCursorCandidate[]
  issues: readonly AiVaultScanIssue[]
  reconcileStats: CursorReconcileStats
}): void {
  const sidecarPaths = new Set(args.sidecarCandidatePaths)
  const parsedSidecars = args.parsedCandidates.filter((candidate) => candidate.sidecar).length
  const failedSidecarPaths = new Set(
    args.issues
      .filter((issue) => issue.agent === 'cursor' && sidecarPaths.has(issue.path))
      .map((issue) => issue.path)
  )
  args.span.setAttribute('cursorSidecarCandidates', sidecarPaths.size)
  args.span.setAttribute('cursorSidecarParsed', parsedSidecars)
  args.span.setAttribute(
    'cursorSidecarSilentlySkipped',
    Math.max(0, sidecarPaths.size - parsedSidecars - failedSidecarPaths.size)
  )
  args.span.setAttribute(
    'cursorSidecarOversized',
    args.issues.filter(
      (issue) =>
        issue.agent === 'cursor' &&
        (issue.message.includes('exceeds the read limit') ||
          issue.message.includes('file_too_large'))
    ).length
  )
  args.span.setAttribute('cursorSuppressedSubagents', args.reconcileStats.suppressedSubagents)
  args.span.setAttribute('cursorFalseOnlyGroups', args.reconcileStats.falseOnlyGroups)
  args.span.setAttribute('cursorReconciledCounterparts', args.reconcileStats.reconciledCounterparts)
  args.span.setAttribute('cursorAmbiguousLegacyIds', args.reconcileStats.ambiguousLegacyIds)
  args.span.setAttribute('cursorBucketCollisions', args.reconcileStats.bucketCollisions)
}

export function recordLocalCursorDiscoverySpan(
  span: ActiveSpan,
  discoveries: readonly SessionFileDiscovery[]
): void {
  const sidecarDiscoveries = discoveries.filter(
    (discovery) => discovery.agent === 'cursor' && discovery.cursorLayout === 'sidecar'
  )
  if (sidecarDiscoveries.length === 0) {
    return
  }
  const counters = sidecarDiscoveries.reduce(
    (total, discovery) => {
      const c = discovery.cursorDiscoveryCounters
      if (!c) {
        return total
      }
      return {
        rootReaddir: total.rootReaddir + c.rootReaddir,
        bucketReaddir: total.bucketReaddir + c.bucketReaddir,
        fileLstat: total.fileLstat + c.fileLstat,
        boundedReads: total.boundedReads + c.boundedReads,
        scopeRealpath: total.scopeRealpath + c.scopeRealpath,
        returnedBytes: total.returnedBytes + c.returnedBytes,
        elapsedMs: Math.max(total.elapsedMs, c.elapsedMs)
      }
    },
    {
      rootReaddir: 0,
      bucketReaddir: 0,
      fileLstat: 0,
      boundedReads: 0,
      scopeRealpath: 0,
      returnedBytes: 0,
      elapsedMs: 0
    }
  )
  const truncated = {
    scopePaths: sidecarDiscoveries.some((d) => d.cursorDiscoveryTruncated?.scopePaths),
    buckets: sidecarDiscoveries.some((d) => d.cursorDiscoveryTruncated?.buckets),
    sessionDirs: sidecarDiscoveries.some((d) => d.cursorDiscoveryTruncated?.sessionDirs),
    sidecarBytes: sidecarDiscoveries.some((d) => d.cursorDiscoveryTruncated?.sidecarBytes)
  }
  span.setAttribute(
    'cursorLocalFilesystemOperations',
    counters.rootReaddir +
      counters.bucketReaddir +
      counters.fileLstat +
      counters.boundedReads +
      counters.scopeRealpath
  )
  span.setAttribute('cursorLocalRootReaddir', counters.rootReaddir)
  span.setAttribute('cursorLocalBucketReaddir', counters.bucketReaddir)
  span.setAttribute('cursorLocalFileLstat', counters.fileLstat)
  span.setAttribute('cursorLocalBoundedReads', counters.boundedReads)
  span.setAttribute('cursorLocalScopeRealpath', counters.scopeRealpath)
  span.setAttribute('cursorLocalReturnedBytes', counters.returnedBytes)
  span.setAttribute('cursorLocalElapsedMs', counters.elapsedMs)
  span.setAttribute('cursorLocalTruncatedScopePaths', truncated.scopePaths)
  span.setAttribute('cursorLocalTruncatedBuckets', truncated.buckets)
  span.setAttribute('cursorLocalTruncatedSessionDirs', truncated.sessionDirs)
  span.setAttribute('cursorLocalTruncatedSidecarBytes', truncated.sidecarBytes)
}

export function recordRemoteCursorScanSpan(
  span: ActiveSpan,
  scan: CursorSidecarScanResponse | null
): void {
  span.setAttribute('cursorSidecarRpcCount', scan ? 1 : 0)
  span.setAttribute('cursorRemoteCapabilityOrSchemaFailure', scan === null)
  if (!scan) {
    return
  }
  const counters = scan.counters
  span.setAttribute(
    'cursorRemoteFilesystemOperations',
    counters.rootReaddir +
      counters.bucketReaddir +
      counters.fileLstat +
      counters.boundedReads +
      counters.scopeRealpath
  )
  span.setAttribute('cursorRemoteRootReaddir', counters.rootReaddir)
  span.setAttribute('cursorRemoteBucketReaddir', counters.bucketReaddir)
  span.setAttribute('cursorRemoteFileLstat', counters.fileLstat)
  span.setAttribute('cursorRemoteBoundedReads', counters.boundedReads)
  span.setAttribute('cursorRemoteScopeRealpath', counters.scopeRealpath)
  span.setAttribute('cursorRemoteReturnedBytes', counters.returnedBytes)
  span.setAttribute('cursorRemoteElapsedMs', counters.elapsedMs)
  span.setAttribute('cursorRemoteTruncatedScopePaths', scan.truncated.scopePaths)
  span.setAttribute('cursorRemoteTruncatedBuckets', scan.truncated.buckets)
  span.setAttribute('cursorRemoteTruncatedSessionDirs', scan.truncated.sessionDirs)
  span.setAttribute('cursorRemoteTruncatedSidecarBytes', scan.truncated.sidecarBytes)
}
