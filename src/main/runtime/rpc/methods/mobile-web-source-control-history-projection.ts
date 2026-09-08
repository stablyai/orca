import type {
  GitHistoryItem,
  GitHistoryItemRef,
  GitHistoryResult
} from '../../../../shared/git-history-types'
import type { RuntimeGitLocalBranches } from '../../../../shared/runtime-worktree-contracts'
import {
  MOBILE_WEB_SOURCE_CONTROL_BRANCH_LIMIT,
  MOBILE_WEB_SOURCE_CONTROL_HISTORY_PARENT_LIMIT,
  MOBILE_WEB_SOURCE_CONTROL_HISTORY_REFERENCE_LIMIT,
  MOBILE_WEB_SOURCE_CONTROL_HISTORY_RESPONSE_MAX_BYTES,
  MobileWebSourceControlBranchesResultSchema,
  MobileWebSourceControlHistoryResultSchema,
  type MobileWebSourceControlHistoryItem,
  type MobileWebSourceControlHistoryRef
} from '../../../../shared/mobile-web/source-control-history-contract'
import {
  boundedText,
  gitObjectId,
  gitRefName,
  RESPONSE_BUDGET_RESERVE_BYTES,
  encodedByteLength
} from './mobile-web-source-control-projection-bounds'

const MESSAGE_MAX_CHARACTERS = 8 * 1024
const SUBJECT_MAX_CHARACTERS = 512

export function projectMobileWebBranches(result: RuntimeGitLocalBranches) {
  const branches = result.branches
    .slice(0, MOBILE_WEB_SOURCE_CONTROL_BRANCH_LIMIT)
    .flatMap((branch) => gitRefName(branch) ?? [])
  const { workspaceId: _workspaceId, ...projected } =
    MobileWebSourceControlBranchesResultSchema.parse({
      workspaceId: 'page',
      current: gitRefName(result.current) ?? null,
      branches,
      totalCount: result.branches.length,
      truncated: branches.length < result.branches.length
    })
  return projected
}

export function projectMobileWebHistory(result: GitHistoryResult, limit: number) {
  const items: MobileWebSourceControlHistoryItem[] = []
  let retainedBytes = 0
  let droppedByBudget = false
  for (const candidate of result.items.slice(0, limit)) {
    const item = projectHistoryItem(candidate)
    if (!item) {
      continue
    }
    const nextBytes = encodedByteLength(item) + 1
    if (
      retainedBytes + nextBytes >
      MOBILE_WEB_SOURCE_CONTROL_HISTORY_RESPONSE_MAX_BYTES - RESPONSE_BUDGET_RESERVE_BYTES
    ) {
      droppedByBudget = true
      break
    }
    retainedBytes += nextBytes
    items.push(item)
  }
  const currentRef = projectHistoryRef(result.currentRef)
  const remoteRef = projectHistoryRef(result.remoteRef)
  const baseRef = projectHistoryRef(result.baseRef)
  const mergeBase = gitObjectId(result.mergeBase)
  const { workspaceId: _workspaceId, ...projected } =
    MobileWebSourceControlHistoryResultSchema.parse({
      workspaceId: 'page',
      items,
      ...(currentRef ? { currentRef } : {}),
      ...(remoteRef ? { remoteRef } : {}),
      ...(baseRef ? { baseRef } : {}),
      ...(mergeBase ? { mergeBase } : {}),
      hasIncomingChanges: result.hasIncomingChanges,
      hasOutgoingChanges: result.hasOutgoingChanges,
      hasMore: result.hasMore || droppedByBudget || items.length < result.items.length,
      limit
    })
  return projected
}

/** A commit whose id is not an object id cannot be addressed by the page contract at all, so it
 * leaves the page rather than arriving unaddressable. */
function projectHistoryItem(item: GitHistoryItem): MobileWebSourceControlHistoryItem | null {
  const id = gitObjectId(item.id)
  if (!id) {
    return null
  }
  const message = boundedText(item.message, MESSAGE_MAX_CHARACTERS) ?? ''
  return {
    id,
    parentIds: item.parentIds
      .slice(0, MOBILE_WEB_SOURCE_CONTROL_HISTORY_PARENT_LIMIT)
      .flatMap((parent) => gitObjectId(parent) ?? []),
    displayId: id.slice(0, 12),
    subject:
      boundedText(item.subject, SUBJECT_MAX_CHARACTERS) ??
      boundedText(message.split(/\r?\n/, 1)[0], SUBJECT_MAX_CHARACTERS) ??
      '(no commit message)',
    message,
    ...(boundedText(item.author, 256) === undefined ? {} : { author: item.author!.slice(0, 256) }),
    ...(safeTimestamp(item.timestamp) === undefined ? {} : { timestamp: item.timestamp }),
    references: (item.references ?? [])
      .slice(0, MOBILE_WEB_SOURCE_CONTROL_HISTORY_REFERENCE_LIMIT)
      .flatMap((reference) => projectHistoryRef(reference) ?? [])
  }
}

function projectHistoryRef(
  reference: GitHistoryItemRef | undefined
): MobileWebSourceControlHistoryRef | null {
  const id = reference && boundedText(reference.id, 320)
  const name = reference && boundedText(reference.name, 240)
  if (!reference || !id || !name) {
    return null
  }
  const revision = gitObjectId(reference.revision)
  const description = boundedText(reference.description, 512)
  return {
    id,
    name,
    ...(revision ? { revision } : {}),
    ...(reference.category ? { category: reference.category } : {}),
    ...(description === undefined ? {} : { description })
  }
}

function safeTimestamp(value: number | undefined): number | undefined {
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value >= -8_640_000_000_000_000 &&
    value <= 8_640_000_000_000_000
    ? value
    : undefined
}
