import type {
  GitBranchChangeEntry,
  GitBranchCompareResult,
  GitCommitCompareResult
} from '../../../../shared/git-diff-compare-types'
import {
  MOBILE_WEB_SOURCE_CONTROL_COMPARE_MAX_ENTRIES,
  MOBILE_WEB_SOURCE_CONTROL_COMPARE_RESPONSE_MAX_BYTES,
  MobileWebSourceControlBranchCompareResultSchema,
  MobileWebSourceControlCommitCompareResultSchema,
  type MobileWebSourceControlCompareEntry
} from '../../../../shared/mobile-web/source-control-history-contract'
import { MobileWebRelativePathSchema } from '../../../../shared/mobile-web/bridge-operation-contract'
import {
  boundedText,
  encodedByteLength,
  gitObjectId,
  RESPONSE_BUDGET_RESERVE_BYTES
} from './mobile-web-source-control-projection-bounds'

export function projectMobileWebBranchCompare(result: GitBranchCompareResult, baseRef: string) {
  const page = compareEntryPage(result.entries)
  const changedFiles = Math.max(result.entries.length, result.summary.changedFiles)
  const { workspaceId: _workspaceId, ...projected } =
    MobileWebSourceControlBranchCompareResultSchema.parse({
      workspaceId: 'page',
      baseRef,
      compareRef: boundedText(result.summary.compareRef, 240) ?? 'HEAD',
      baseOid: gitObjectId(result.summary.baseOid),
      headOid: gitObjectId(result.summary.headOid),
      mergeBase: gitObjectId(result.summary.mergeBase),
      changedFiles,
      ...(result.summary.commitsAhead === undefined
        ? {}
        : { commitsAhead: result.summary.commitsAhead }),
      status: result.summary.status === 'loading' ? 'error' : result.summary.status,
      entries: page.entries,
      truncated: page.truncated || changedFiles > page.entries.length
    })
  return projected
}

export function projectMobileWebCommitCompare(result: GitCommitCompareResult, commitId: string) {
  const page = compareEntryPage(result.entries)
  const changedFiles = Math.max(result.entries.length, result.summary.changedFiles)
  const { workspaceId: _workspaceId, ...projected } =
    MobileWebSourceControlCommitCompareResultSchema.parse({
      workspaceId: 'page',
      commitId,
      commitOid: gitObjectId(result.summary.commitOid),
      parentOid: gitObjectId(result.summary.parentOid),
      compareRef: boundedText(result.summary.compareRef, 240) ?? commitId.slice(0, 12),
      baseRef: boundedText(result.summary.baseRef, 240) ?? 'parent',
      changedFiles,
      status: result.summary.status,
      entries: page.entries,
      truncated: page.truncated || changedFiles > page.entries.length
    })
  return projected
}

/** One response carries the whole compare, so the entry list is bounded by both the entry cap and
 * the bridge response budget rather than by a resumable offset the page would have to drive. */
function compareEntryPage(candidates: readonly GitBranchChangeEntry[]): {
  entries: MobileWebSourceControlCompareEntry[]
  truncated: boolean
} {
  const entries: MobileWebSourceControlCompareEntry[] = []
  let retainedBytes = 0
  let droppedByBudget = false
  for (const candidate of candidates.slice(0, MOBILE_WEB_SOURCE_CONTROL_COMPARE_MAX_ENTRIES)) {
    const entry = compareEntry(candidate)
    if (!entry) {
      continue
    }
    const nextBytes = encodedByteLength(entry) + 1
    if (
      retainedBytes + nextBytes >
      MOBILE_WEB_SOURCE_CONTROL_COMPARE_RESPONSE_MAX_BYTES - RESPONSE_BUDGET_RESERVE_BYTES
    ) {
      droppedByBudget = true
      break
    }
    retainedBytes += nextBytes
    entries.push(entry)
  }
  return { entries, truncated: droppedByBudget || entries.length < candidates.length }
}

/** A changed file the page cannot address as a workspace-relative path leaves the list. */
function compareEntry(entry: GitBranchChangeEntry): MobileWebSourceControlCompareEntry | null {
  const relativePath = MobileWebRelativePathSchema.safeParse(entry.path)
  if (!relativePath.success) {
    return null
  }
  const oldRelativePath = MobileWebRelativePathSchema.safeParse(entry.oldPath)
  return {
    relativePath: relativePath.data,
    ...(oldRelativePath.success ? { oldRelativePath: oldRelativePath.data } : {}),
    status: entry.status,
    ...(entry.added === undefined ? {} : { added: entry.added }),
    ...(entry.removed === undefined ? {} : { removed: entry.removed })
  }
}
