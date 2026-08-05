import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { ActiveSpan } from '../observability/tracer'
import type { RemoteScannerContext, RemoteSessionCandidate } from './remote-session-scanner-types'
import {
  recordCursorScanSpan,
  recordRemoteCursorScanSpan
} from './session-scanner-cursor-observability'
import {
  reconcileCursorCandidates,
  type ParsedCursorCandidate
} from './session-scanner-cursor-reconcile'
import { parseCursorSidecarContent } from './session-scanner-cursor-sidecar'
import type { CursorSidecarScanResponse } from '../../shared/cursor-sidecar-scan'
import { errorMessage } from './session-scanner-values'
import {
  buildCursorCandidateSelectionGroups,
  canStopCursorGroupSelection,
  selectCursorScopedGroups,
  type CursorCandidateSelectionGroup
} from './session-scanner-cursor-selection'

const REMOTE_CURSOR_PARSE_CONCURRENCY = 8

export async function processRemoteCursorCandidates(args: {
  candidates: readonly RemoteSessionCandidate[]
  limit: number
  scopeLimit: number
  context: RemoteScannerContext
  issues: AiVaultScanIssue[]
  span: ActiveSpan
  scan: CursorSidecarScanResponse | null
  parseLegacy: (candidate: RemoteSessionCandidate) => Promise<AiVaultSession | null>
}): Promise<ReturnType<typeof reconcileCursorCandidates>> {
  const groups = buildCursorCandidateSelectionGroups({
    candidates: args.candidates,
    platform: args.context.hostPlatform.os,
    adapter: {
      getCwdEvidence: (candidate) => candidate.cursorCwdEvidence,
      getFile: (candidate) => candidate.file,
      getLayout: (candidate) => candidate.source.cursorLayout ?? 'legacy',
      getStorageContextKey: (candidate) =>
        candidate.source.cursorStorageContextKey || args.context.executionHostId
    }
  })
  const parsed: ParsedCursorCandidate[] = []
  const processedGroups = new Set<CursorCandidateSelectionGroup<RemoteSessionCandidate>>()
  for (let index = 0; index < groups.length; index += REMOTE_CURSOR_PARSE_CONCURRENCY) {
    const preview = reconcileCursorCandidates({
      candidates: parsed,
      executionHostId: args.context.executionHostId,
      platform: args.context.hostPlatform.os,
      issues: []
    })
    if (canStopCursorGroupSelection(preview.sessions, args.limit, groups[index]?.mtimeMs)) {
      break
    }
    const batch = groups.slice(index, index + REMOTE_CURSOR_PARSE_CONCURRENCY)
    await parseCursorGroups(batch, parsed, args)
    batch.forEach((group) => processedGroups.add(group))
  }
  const scopedGroups = selectCursorScopedGroups(groups, processedGroups, args.scopeLimit)
  for (let index = 0; index < scopedGroups.length; index += REMOTE_CURSOR_PARSE_CONCURRENCY) {
    await parseCursorGroups(
      scopedGroups.slice(index, index + REMOTE_CURSOR_PARSE_CONCURRENCY),
      parsed,
      args
    )
  }
  const reconciled = reconcileCursorCandidates({
    candidates: parsed,
    executionHostId: args.context.executionHostId,
    platform: args.context.hostPlatform.os,
    issues: args.issues
  })
  recordCursorScanSpan({
    span: args.span,
    sidecarCandidatePaths: args.candidates
      .filter((candidate) => candidate.source.cursorLayout === 'sidecar')
      .map((candidate) => candidate.file.path),
    parsedCandidates: parsed,
    issues: args.issues,
    reconcileStats: reconciled.stats
  })
  recordRemoteCursorScanSpan(args.span, args.scan)
  return reconciled
}

async function parseCursorGroups(
  groups: readonly CursorCandidateSelectionGroup<RemoteSessionCandidate>[],
  parsed: ParsedCursorCandidate[],
  args: {
    context: RemoteScannerContext
    issues: AiVaultScanIssue[]
    parseLegacy: (candidate: RemoteSessionCandidate) => Promise<AiVaultSession | null>
  }
): Promise<void> {
  const candidates = groups.flatMap((group) => group.candidates)
  for (let index = 0; index < candidates.length; index += REMOTE_CURSOR_PARSE_CONCURRENCY) {
    const batch = candidates.slice(index, index + REMOTE_CURSOR_PARSE_CONCURRENCY)
    const results = await Promise.all(
      batch.map((candidate) => parseCursorCandidate(candidate, args))
    )
    parsed.push(...results.filter((result): result is ParsedCursorCandidate => Boolean(result)))
  }
}

async function parseCursorCandidate(
  candidate: RemoteSessionCandidate,
  args: {
    context: RemoteScannerContext
    issues: AiVaultScanIssue[]
    parseLegacy: (candidate: RemoteSessionCandidate) => Promise<AiVaultSession | null>
  }
): Promise<ParsedCursorCandidate | null> {
  const layout = candidate.source.cursorLayout ?? 'legacy'
  if (layout === 'legacy') {
    const legacy = await args.parseLegacy(candidate)
    return legacy
      ? {
          layout,
          storageContextKey:
            candidate.source.cursorStorageContextKey || args.context.executionHostId,
          file: candidate.file,
          cwdEvidence: candidate.cursorCwdEvidence,
          legacy
        }
      : null
  }
  try {
    if (candidate.cursorSidecarContent === undefined) {
      return null
    }
    const result = parseCursorSidecarContent({
      file: candidate.file,
      content: candidate.cursorSidecarContent,
      platform: args.context.hostPlatform.os,
      executionHostId: args.context.executionHostId
    })
    if (result.issue) {
      args.issues.push(result.issue)
    }
    return result.evidence
      ? {
          layout,
          storageContextKey:
            candidate.source.cursorStorageContextKey || args.context.executionHostId,
          file: candidate.file,
          cwdEvidence: candidate.cursorCwdEvidence,
          sidecar: result.evidence
        }
      : null
  } catch (error) {
    args.issues.push({
      executionHostId: args.context.executionHostId,
      agent: 'cursor',
      path: candidate.file.path,
      message: errorMessage(error)
    })
    return null
  }
}
