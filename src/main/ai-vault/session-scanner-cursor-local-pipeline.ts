import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { ActiveSpan } from '../observability/tracer'
import { parseAgentSessionFileCached } from './session-scanner-parse-cache'
import type { SessionParseStats } from './session-scanner-parse-cache'
import { recordCursorScanSpan } from './session-scanner-cursor-observability'
import {
  reconcileCursorCandidates,
  type ParsedCursorCandidate
} from './session-scanner-cursor-reconcile'
import { parseCursorSidecarFileCached } from './session-scanner-cursor-sidecar'
import type { SessionFileCandidate } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'
import {
  buildCursorCandidateSelectionGroups,
  canStopCursorGroupSelection,
  selectCursorScopedGroups,
  type CursorCandidateSelectionGroup
} from './session-scanner-cursor-selection'

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
    await parseCursorGroups(batch, parsed, args)
    batch.forEach((group) => processedGroups.add(group))
  }
  const scopedGroups = selectCursorScopedGroups(groups, processedGroups, args.scopeLimit)
  for (let index = 0; index < scopedGroups.length; index += CURSOR_PARSE_CONCURRENCY) {
    const batch = scopedGroups.slice(index, index + CURSOR_PARSE_CONCURRENCY)
    await parseCursorGroups(batch, parsed, args)
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

async function parseCursorGroups(
  groups: readonly CursorCandidateSelectionGroup<SessionFileCandidate>[],
  parsed: ParsedCursorCandidate[],
  args: {
    platform: NodeJS.Platform
    executionHostId: ExecutionHostId
    issues: AiVaultScanIssue[]
    parseStats: SessionParseStats
  }
): Promise<void> {
  const candidates = groups.flatMap((group) => group.candidates)
  for (let index = 0; index < candidates.length; index += CURSOR_PARSE_CONCURRENCY) {
    const batch = candidates.slice(index, index + CURSOR_PARSE_CONCURRENCY)
    const results = await Promise.all(
      batch.map((candidate) => parseCursorCandidate(candidate, args))
    )
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
  }
): Promise<ParsedCursorCandidate | null> {
  const layout = candidate.cursorLayout ?? 'legacy'
  try {
    if (layout === 'sidecar') {
      const result = await parseCursorSidecarFileCached({
        file: candidate.file,
        platform: args.platform,
        executionHostId: args.executionHostId,
        expectedRootRealPath: candidate.cursorExpectedRootRealPath
      })
      if (result.issue) {
        args.issues.push(result.issue)
      }
      return result.evidence
        ? {
            layout,
            storageContextKey: candidate.cursorStorageContextKey ?? 'native',
            file: candidate.file,
            cwdEvidence: candidate.cursorCwdEvidence,
            sidecar: result.evidence
          }
        : null
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
    args.issues.push({
      executionHostId: args.executionHostId,
      agent: 'cursor',
      path: candidate.file.path,
      message: errorMessage(error)
    })
    return null
  }
}
