import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { CursorSidecarScanResponse } from '../../shared/cursor-sidecar-scan'
import type { ActiveSpan } from '../observability/tracer'
import type {
  CursorReconcileStats,
  ParsedCursorCandidate
} from './session-scanner-cursor-reconcile'

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
