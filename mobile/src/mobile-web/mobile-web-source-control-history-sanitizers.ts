import {
  MOBILE_WEB_SOURCE_CONTROL_BRANCH_LIMIT,
  MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT,
  MOBILE_WEB_SOURCE_CONTROL_COMPARE_MAX_ENTRIES,
  MOBILE_WEB_SOURCE_CONTROL_COMPARE_RESPONSE_MAX_BYTES,
  MOBILE_WEB_SOURCE_CONTROL_HISTORY_RESPONSE_MAX_BYTES,
  MobileWebGitObjectIdSchema,
  MobileWebGitRefNameSchema,
  MobileWebSourceControlBranchCompareResultSchema,
  MobileWebSourceControlBranchesResultSchema,
  MobileWebSourceControlCommitCompareResultSchema,
  MobileWebSourceControlCompareEntrySchema,
  MobileWebSourceControlHistoryResultSchema,
  type MobileWebSourceControlBranchCompareResult,
  type MobileWebSourceControlBranchComparePayload,
  type MobileWebSourceControlBranchesResult,
  type MobileWebSourceControlCommitCompareResult,
  type MobileWebSourceControlCompareEntry,
  type MobileWebSourceControlHistoryItem,
  type MobileWebSourceControlHistoryResult
} from '../../../src/shared/mobile-web/source-control-history-contract'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import {
  mobileWebBranchCompareRevision,
  mobileWebCompareEntryPage
} from './mobile-web-source-control-compare-page'
import {
  sanitizeMobileWebHistoryItem,
  sanitizeMobileWebHistoryRef
} from './mobile-web-source-control-history-item-sanitizer'

export function sanitizeMobileWebBranches(
  result: unknown,
  workspaceId: string
): MobileWebSourceControlBranchesResult {
  if (!isRecord(result) || !Array.isArray(result.branches)) {
    throw new MobileWebBrokerError('host_error')
  }
  const branches = result.branches
    .slice(0, MOBILE_WEB_SOURCE_CONTROL_BRANCH_LIMIT)
    .flatMap((candidate) => {
      const branch = sanitizeGitRef(candidate)
      return branch ? [branch] : []
    })
  const current = sanitizeGitRef(result.current)
  return MobileWebSourceControlBranchesResultSchema.parse({
    workspaceId,
    current,
    branches,
    totalCount: result.branches.length,
    truncated:
      result.branches.length > MOBILE_WEB_SOURCE_CONTROL_BRANCH_LIMIT ||
      branches.length < Math.min(result.branches.length, MOBILE_WEB_SOURCE_CONTROL_BRANCH_LIMIT)
  })
}

export function sanitizeMobileWebHistory(
  result: unknown,
  workspaceId: string,
  limit: number
): MobileWebSourceControlHistoryResult {
  if (!isRecord(result) || !Array.isArray(result.items)) {
    throw new MobileWebBrokerError('host_error')
  }
  const items: MobileWebSourceControlHistoryItem[] = []
  let retainedBytes = 0
  let droppedByBudget = false
  for (const candidate of result.items.slice(0, limit)) {
    const item = sanitizeMobileWebHistoryItem(candidate)
    if (!item) {
      continue
    }
    const nextBytes = encodedByteLength(item) + 1
    if (
      retainedBytes + nextBytes >
      MOBILE_WEB_SOURCE_CONTROL_HISTORY_RESPONSE_MAX_BYTES - 8 * 1024
    ) {
      droppedByBudget = true
      break
    }
    retainedBytes += nextBytes
    items.push(item)
  }
  const currentRef = sanitizeMobileWebHistoryRef(result.currentRef)
  const remoteRef = sanitizeMobileWebHistoryRef(result.remoteRef)
  const baseRef = sanitizeMobileWebHistoryRef(result.baseRef)
  const mergeBase = sanitizeObjectId(result.mergeBase)
  return MobileWebSourceControlHistoryResultSchema.parse({
    workspaceId,
    items,
    ...(currentRef ? { currentRef } : {}),
    ...(remoteRef ? { remoteRef } : {}),
    ...(baseRef ? { baseRef } : {}),
    ...(mergeBase ? { mergeBase } : {}),
    hasIncomingChanges: result.hasIncomingChanges === true,
    hasOutgoingChanges: result.hasOutgoingChanges === true,
    hasMore:
      result.hasMore === true ||
      droppedByBudget ||
      result.items.length > limit ||
      items.length < Math.min(result.items.length, limit),
    limit
  })
}

export function sanitizeMobileWebBranchCompare(
  result: unknown,
  payload: MobileWebSourceControlBranchComparePayload
): MobileWebSourceControlBranchCompareResult {
  const summary = compareSummary(result)
  const sanitized = sanitizeCompareEntries(result, MOBILE_WEB_SOURCE_CONTROL_COMPARE_MAX_ENTRIES)
  const changedFiles = Math.max(
    sanitized.reportedCount,
    safeNonnegativeInteger(summary.changedFiles)
  )
  const commitsAhead = optionalNonnegativeInteger(summary.commitsAhead)
  const snapshot = {
    workspaceId: payload.workspaceId,
    baseRef: payload.baseRef,
    compareRef: boundedString(summary.compareRef, 240) ?? 'HEAD',
    baseOid: sanitizeObjectId(summary.baseOid),
    headOid: sanitizeObjectId(summary.headOid),
    mergeBase: sanitizeObjectId(summary.mergeBase),
    changedFiles,
    ...(commitsAhead === undefined ? {} : { commitsAhead }),
    status: branchCompareStatus(summary.status),
    totalEntries: sanitized.entries.length,
    truncated: sanitized.truncated || changedFiles > sanitized.entries.length
  }
  const revision = mobileWebBranchCompareRevision(snapshot, sanitized.entries)
  if (payload.expectedRevision && payload.expectedRevision !== revision) {
    throw new MobileWebBrokerError('conflict')
  }
  const entries = mobileWebCompareEntryPage(
    snapshot,
    sanitized.entries,
    payload.offset,
    payload.limit
  )
  const nextOffset =
    payload.offset + entries.length < sanitized.entries.length
      ? payload.offset + entries.length
      : null
  return MobileWebSourceControlBranchCompareResultSchema.parse({
    ...snapshot,
    revision,
    offset: payload.offset,
    entries,
    nextOffset,
    truncated: snapshot.truncated || nextOffset !== null
  })
}

export function sanitizeMobileWebCommitCompare(
  result: unknown,
  workspaceId: string,
  commitId: string
): MobileWebSourceControlCommitCompareResult {
  const summary = compareSummary(result)
  const sanitized = sanitizeCompareEntries(
    result,
    MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT,
    true
  )
  const changedFiles = Math.max(
    sanitized.reportedCount,
    safeNonnegativeInteger(summary.changedFiles)
  )
  return MobileWebSourceControlCommitCompareResultSchema.parse({
    workspaceId,
    commitId,
    commitOid: sanitizeObjectId(summary.commitOid),
    parentOid: sanitizeObjectId(summary.parentOid),
    compareRef: boundedString(summary.compareRef, 240) ?? commitId.slice(0, 12),
    baseRef: boundedString(summary.baseRef, 240) ?? 'parent',
    changedFiles,
    status: commitCompareStatus(summary.status),
    entries: sanitized.entries,
    truncated: sanitized.truncated || changedFiles > sanitized.entries.length
  })
}

function sanitizeCompareEntries(
  result: unknown,
  limit: number,
  enforceResponseBudget = false
): {
  entries: MobileWebSourceControlCompareEntry[]
  reportedCount: number
  truncated: boolean
} {
  if (!isRecord(result) || !Array.isArray(result.entries)) {
    throw new MobileWebBrokerError('host_error')
  }
  const entries: MobileWebSourceControlCompareEntry[] = []
  let droppedByBudget = false
  for (const candidate of result.entries.slice(0, limit)) {
    const entry = sanitizeCompareEntry(candidate)
    if (!entry) {
      continue
    }
    if (
      enforceResponseBudget &&
      encodedByteLength([...entries, entry]) >
        MOBILE_WEB_SOURCE_CONTROL_COMPARE_RESPONSE_MAX_BYTES - 8 * 1024
    ) {
      droppedByBudget = true
      break
    }
    entries.push(entry)
  }
  return {
    entries,
    reportedCount: result.entries.length,
    truncated:
      result.entries.length > limit ||
      droppedByBudget ||
      entries.length < Math.min(result.entries.length, limit)
  }
}

function sanitizeCompareEntry(candidate: unknown): MobileWebSourceControlCompareEntry | null {
  if (!isRecord(candidate)) {
    return null
  }
  const parsed = MobileWebSourceControlCompareEntrySchema.safeParse({
    relativePath: candidate.path,
    ...(candidate.oldPath === undefined ? {} : { oldRelativePath: candidate.oldPath }),
    status: candidate.status,
    ...(optionalNonnegativeInteger(candidate.added) === undefined
      ? {}
      : { added: candidate.added }),
    ...(optionalNonnegativeInteger(candidate.removed) === undefined
      ? {}
      : { removed: candidate.removed })
  })
  return parsed.success ? parsed.data : null
}

function compareSummary(result: unknown): Record<string, unknown> {
  if (!isRecord(result) || !isRecord(result.summary)) {
    throw new MobileWebBrokerError('host_error')
  }
  return result.summary
}

function branchCompareStatus(
  value: unknown
): 'ready' | 'invalid-base' | 'unborn-head' | 'no-merge-base' | 'error' {
  return value === 'ready' ||
    value === 'invalid-base' ||
    value === 'unborn-head' ||
    value === 'no-merge-base'
    ? value
    : 'error'
}

function commitCompareStatus(value: unknown): 'ready' | 'invalid-commit' | 'error' {
  return value === 'ready' || value === 'invalid-commit' ? value : 'error'
}

function sanitizeGitRef(value: unknown): string | null {
  if (value === null) {
    return null
  }
  const parsed = MobileWebGitRefNameSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function sanitizeObjectId(value: unknown): string | null {
  const parsed = MobileWebGitObjectIdSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function safeNonnegativeInteger(value: unknown): number {
  return optionalNonnegativeInteger(value) ?? 0
}

function optionalNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function boundedString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : undefined
}

function encodedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
