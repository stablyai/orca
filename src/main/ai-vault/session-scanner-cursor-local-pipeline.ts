import { isAiVaultScanCancelledError, type AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  CURSOR_REMOTE_MAX_AGGREGATE_BYTES,
  CURSOR_SIDECAR_MAX_BYTES
} from '../../shared/cursor-sidecar-scan'
import { isCursorSidecarScanCancelledError } from '../../shared/cursor-sidecar-scan-discovery'
import type { ActiveSpan } from '../observability/tracer'
import { parseAgentSessionFileCached } from './session-scanner-parse-cache'
import type { SessionParseStats } from './session-scanner-parse-cache'
import { recordCursorScanSpan } from './session-scanner-cursor-observability'
import {
  reconcileCursorCandidates,
  type ParsedCursorCandidate
} from './session-scanner-cursor-reconcile'
import { parseCursorSidecarFileCached } from './session-scanner-cursor-sidecar'
import type { SessionFileCandidate, SessionFileDiscovery } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import {
  buildCursorCandidateSelectionGroups,
  canStopCursorGroupSelection,
  selectCursorScopedGroups,
  type CursorCandidateSelectionGroup
} from './session-scanner-cursor-selection'
import {
  createCursorVerifiedReadBudget,
  reserveCursorVerifiedReadBytes,
  settleCursorVerifiedReadReservation,
  type CursorVerifiedReadBudget
} from './session-scanner-cursor-read-budget'

const CURSOR_PARSE_CONCURRENCY = 8

export async function processLocalCursorCandidates(args: {
  candidates: readonly SessionFileCandidate[]
  limit: number
  scopeLimit: number
  platform: NodeJS.Platform
  executionHostId: ExecutionHostId
  issues: AiVaultScanIssue[]
  parseStats: SessionParseStats
  span: ActiveSpan
  discoveries?: readonly SessionFileDiscovery[]
  signal?: AbortSignal
}): Promise<ReturnType<typeof reconcileCursorCandidates>> {
  const groups = buildCursorCandidateSelectionGroups({
    candidates: args.candidates,
    platform: args.platform,
    adapter: {
      getCwdEvidence: (candidate) => candidate.cursorCwdEvidence,
      getFile: (candidate) => candidate.file,
      getLayout: (candidate) => candidate.cursorLayout ?? 'legacy',
      getStorageContextKey: (candidate) => candidate.cursorStorageContextKey ?? 'native'
    }
  })
  const verifiedReads = createVerifiedReadTracker(args.discoveries)
  const parsed: ParsedCursorCandidate[] = []
  const processedGroups = new Set<CursorCandidateSelectionGroup<SessionFileCandidate>>()
  for (let index = 0; index < groups.length; index += CURSOR_PARSE_CONCURRENCY) {
    // Reconcile is O(parsed); sessions never outnumber candidates, so a short parsed
    // count can't satisfy the limit and the preview would be wasted work.
    if (parsed.length >= args.limit) {
      const preview = reconcileCursorCandidates({
        candidates: parsed,
        executionHostId: args.executionHostId,
        platform: args.platform,
        issues: []
      })
      if (canStopCursorGroupSelection(preview.sessions, args.limit, groups[index]?.mtimeMs)) {
        break
      }
    }
    const batch = groups.slice(index, index + CURSOR_PARSE_CONCURRENCY)
    await parseCursorGroups(batch, parsed, args, verifiedReads)
    batch.forEach((group) => processedGroups.add(group))
  }
  const scopedGroups = selectCursorScopedGroups(groups, processedGroups, args.scopeLimit)
  for (let index = 0; index < scopedGroups.length; index += CURSOR_PARSE_CONCURRENCY) {
    const batch = scopedGroups.slice(index, index + CURSOR_PARSE_CONCURRENCY)
    await parseCursorGroups(batch, parsed, args, verifiedReads)
  }
  const reconciled = reconcileCursorCandidates({
    candidates: parsed,
    executionHostId: args.executionHostId,
    platform: args.platform,
    issues: args.issues
  })
  recordCursorScanSpan({
    span: args.span,
    sidecarCandidatePaths: args.candidates
      .filter((candidate) => candidate.cursorLayout === 'sidecar')
      .map((candidate) => candidate.file.path),
    parsedCandidates: parsed,
    issues: args.issues,
    reconcileStats: reconciled.stats
  })
  return reconciled
}

type VerifiedReadTracker = {
  byStorageKey: Map<
    string,
    {
      counters: NonNullable<SessionFileDiscovery['cursorDiscoveryCounters']>
      truncated: NonNullable<SessionFileDiscovery['cursorDiscoveryTruncated']>
    }
  >
  budgetsByStorageKey: Map<string, CursorVerifiedReadBudget>
}

function createVerifiedReadTracker(
  discoveries: readonly SessionFileDiscovery[] | undefined
): VerifiedReadTracker {
  const byStorageKey = new Map<
    string,
    {
      counters: NonNullable<SessionFileDiscovery['cursorDiscoveryCounters']>
      truncated: NonNullable<SessionFileDiscovery['cursorDiscoveryTruncated']>
    }
  >()
  for (const discovery of discoveries ?? []) {
    if (
      discovery.agent !== 'cursor' ||
      discovery.cursorLayout !== 'sidecar' ||
      !discovery.cursorDiscoveryCounters ||
      !discovery.cursorDiscoveryTruncated
    ) {
      continue
    }
    byStorageKey.set(discovery.cursorStorageContextKey ?? 'native', {
      counters: discovery.cursorDiscoveryCounters,
      truncated: discovery.cursorDiscoveryTruncated
    })
  }
  return { byStorageKey, budgetsByStorageKey: new Map() }
}

function verifiedReadBudget(
  tracker: VerifiedReadTracker,
  storageKey: string
): CursorVerifiedReadBudget {
  const existing = tracker.budgetsByStorageKey.get(storageKey)
  if (existing) {
    return existing
  }
  const created = createCursorVerifiedReadBudget()
  tracker.budgetsByStorageKey.set(storageKey, created)
  return created
}

async function parseCursorGroups(
  groups: readonly CursorCandidateSelectionGroup<SessionFileCandidate>[],
  parsed: ParsedCursorCandidate[],
  args: {
    platform: NodeJS.Platform
    executionHostId: ExecutionHostId
    issues: AiVaultScanIssue[]
    parseStats: SessionParseStats
    signal?: AbortSignal
  },
  verifiedReads: VerifiedReadTracker
): Promise<void> {
  const candidates = groups.flatMap((group) => group.candidates)
  for (let index = 0; index < candidates.length; index += CURSOR_PARSE_CONCURRENCY) {
    const batch = candidates.slice(index, index + CURSOR_PARSE_CONCURRENCY)
    const settled = await Promise.allSettled(
      batch.map((candidate) => parseCursorCandidate(candidate, args, verifiedReads))
    )
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (rejected) {
      throw rejected.reason
    }
    const results = settled.map((result) => (result.status === 'fulfilled' ? result.value : null))
    parsed.push(...results.filter((result): result is ParsedCursorCandidate => Boolean(result)))
  }
}

async function parseCursorCandidate(
  candidate: SessionFileCandidate,
  args: {
    platform: NodeJS.Platform
    executionHostId: ExecutionHostId
    issues: AiVaultScanIssue[]
    parseStats: SessionParseStats
    signal?: AbortSignal
  },
  verifiedReads: VerifiedReadTracker
): Promise<ParsedCursorCandidate | null> {
  const layout = candidate.cursorLayout ?? 'legacy'
  try {
    if (layout === 'sidecar') {
      return await parseSidecarWithAggregateCap(candidate, args, verifiedReads)
    }
    const legacy = await parseAgentSessionFileCached(candidate, args.platform, args.parseStats)
    return legacy
      ? {
          layout,
          storageContextKey: candidate.cursorStorageContextKey ?? 'native',
          file: candidate.file,
          cwdEvidence: candidate.cursorCwdEvidence,
          legacy
        }
      : null
  } catch (error) {
    if (isCursorSidecarScanCancelledError(error) || isAiVaultScanCancelledError(error)) {
      throw error
    }
    args.issues.push({
      executionHostId: args.executionHostId,
      agent: 'cursor',
      path: candidate.file.path,
      message: errorMessage(error)
    })
    return null
  }
}

async function parseSidecarWithAggregateCap(
  candidate: SessionFileCandidate,
  args: {
    platform: NodeJS.Platform
    executionHostId: ExecutionHostId
    issues: AiVaultScanIssue[]
    signal?: AbortSignal
  },
  verifiedReads: VerifiedReadTracker
): Promise<ParsedCursorCandidate | null> {
  const storageKey = candidate.cursorStorageContextKey ?? 'native'
  const storage = verifiedReads.byStorageKey.get(storageKey)
  const budget = verifiedReadBudget(verifiedReads, storageKey)
  // Unknown size reserves the per-sidecar max so concurrent admission cannot overshoot.
  const estimatedBytes =
    candidate.file.sizeBytes === undefined
      ? CURSOR_SIDECAR_MAX_BYTES
      : Math.min(Math.max(0, candidate.file.sizeBytes), CURSOR_SIDECAR_MAX_BYTES)
  const reservedBytes = await reserveCursorVerifiedReadBytes(budget, estimatedBytes, args.signal)
  if (reservedBytes === null) {
    if (storage) {
      storage.truncated.sidecarBytes = true
    }
    return null
  }

  let result
  try {
    result = await parseCursorSidecarFileCached({
      file: candidate.file,
      platform: args.platform,
      targetPlatform: candidate.cursorTargetPlatform,
      executionHostId: args.executionHostId,
      expectedRootRealPath: candidate.cursorExpectedRootRealPath,
      maxBytes: reservedBytes
    })
  } catch (error) {
    settleCursorVerifiedReadReservation(
      budget,
      reservedBytes,
      isVerifiedReadTooLargeError(error)
        ? CURSOR_REMOTE_MAX_AGGREGATE_BYTES
        : CURSOR_SIDECAR_MAX_BYTES
    )
    if (storage) {
      storage.counters.boundedReads += 1
      if (isVerifiedReadTooLargeError(error)) {
        storage.truncated.sidecarBytes = true
      }
    }
    throwIfAiVaultScanCancelled(args.signal)
    throw error
  }

  const readBytes = result.cacheHit ? 0 : (result.returnedBytes ?? 0)
  settleCursorVerifiedReadReservation(budget, reservedBytes, readBytes)
  if (!result.cacheHit && storage) {
    storage.counters.boundedReads += 1
    storage.counters.returnedBytes += readBytes
  }
  throwIfAiVaultScanCancelled(args.signal)

  if (result.issue) {
    args.issues.push(result.issue)
  }
  return result.evidence
    ? {
        layout: 'sidecar' as const,
        storageContextKey: storageKey,
        file: candidate.file,
        cwdEvidence: candidate.cursorCwdEvidence,
        sidecar: result.evidence
      }
    : null
}

function isVerifiedReadTooLargeError(error: unknown): boolean {
  return error instanceof Error && error.message === 'file_too_large'
}
