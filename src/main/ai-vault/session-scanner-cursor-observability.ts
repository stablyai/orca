import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
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
  const cursorDiscoveries = discoveries.filter((discovery) => discovery.agent === 'cursor')
  const sidecarDiscoveries = discoveries.filter(
    (discovery) => discovery.agent === 'cursor' && discovery.cursorLayout === 'sidecar'
  )
  if (cursorDiscoveries.length === 0) {
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
        direntsRead: total.direntsRead + c.direntsRead,
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
      direntsRead: 0,
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
  const legacyCounters = cursorDiscoveries.reduce(
    (total, discovery) => {
      const c = discovery.cursorLegacyDiscoveryCounters
      if (!c) {
        return total
      }
      return {
        directoryReaddir: total.directoryReaddir + c.directoryReaddir,
        direntsRead: total.direntsRead + c.direntsRead,
        fileStat: total.fileStat + c.fileStat,
        scopeRealpath: total.scopeRealpath + c.scopeRealpath
      }
    },
    { directoryReaddir: 0, direntsRead: 0, fileStat: 0, scopeRealpath: 0 }
  )
  const legacyOperations =
    legacyCounters.directoryReaddir +
    legacyCounters.direntsRead +
    legacyCounters.fileStat +
    legacyCounters.scopeRealpath
  span.setAttribute(
    'cursorLocalFilesystemOperations',
    counters.rootReaddir +
      counters.bucketReaddir +
      counters.direntsRead +
      counters.fileLstat +
      counters.boundedReads +
      counters.scopeRealpath +
      legacyOperations
  )
  span.setAttribute('cursorLocalRootReaddir', counters.rootReaddir)
  span.setAttribute('cursorLocalBucketReaddir', counters.bucketReaddir)
  span.setAttribute('cursorLocalDirentsRead', counters.direntsRead)
  span.setAttribute('cursorLocalFileLstat', counters.fileLstat)
  span.setAttribute('cursorLocalBoundedReads', counters.boundedReads)
  span.setAttribute('cursorLocalScopeRealpath', counters.scopeRealpath)
  span.setAttribute('cursorLocalReturnedBytes', counters.returnedBytes)
  span.setAttribute('cursorLocalElapsedMs', counters.elapsedMs)
  span.setAttribute('cursorLocalTruncatedScopePaths', truncated.scopePaths)
  span.setAttribute('cursorLocalTruncatedBuckets', truncated.buckets)
  span.setAttribute('cursorLocalTruncatedSessionDirs', truncated.sessionDirs)
  span.setAttribute('cursorLocalTruncatedSidecarBytes', truncated.sidecarBytes)
  span.setAttribute('cursorLocalLegacyDirectoryReaddir', legacyCounters.directoryReaddir)
  span.setAttribute('cursorLocalLegacyDirentsRead', legacyCounters.direntsRead)
  span.setAttribute('cursorLocalLegacyFileStat', legacyCounters.fileStat)
  span.setAttribute('cursorLocalLegacyScopeRealpath', legacyCounters.scopeRealpath)
  span.setAttribute(
    'cursorLocalLegacyTruncatedEntries',
    cursorDiscoveries.some((d) => d.cursorLegacyDiscoveryTruncated?.entries)
  )
  span.setAttribute(
    'cursorLocalLegacyTruncatedFiles',
    cursorDiscoveries.some((d) => d.cursorLegacyDiscoveryTruncated?.files)
  )
}
