import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import {
  MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT,
  MOBILE_WEB_SOURCE_CONTROL_COMPARE_MAX_ENTRIES,
  type MobileWebSourceControlBranchCompareResult
} from '../../../src/shared/mobile-web/source-control-history-contract'
import type { WebHostSourceControlStatusSnapshot } from './web-host-source-control-status-snapshot'

type RequestParams = Record<string, unknown>

export async function readWebHostSourceControlRequest(args: {
  client: MobileWebBridgeClient
  workspaceId: string
  method: string
  params: RequestParams
  statusSnapshot: WebHostSourceControlStatusSnapshot
}): Promise<unknown | typeof WEB_HOST_SOURCE_CONTROL_REQUEST_UNHANDLED> {
  const { client, workspaceId, method, params, statusSnapshot } = args
  if (method === 'git.status') {
    const [status, repository] = await Promise.all([
      statusSnapshot.refresh(),
      client.sourceControlUpstream({ workspaceId })
    ])
    return {
      entries: status.entries.map((entry) => ({
        path: entry.relativePath,
        ...(entry.oldRelativePath ? { oldPath: entry.oldRelativePath } : {}),
        status: entry.status,
        area: entry.area,
        ...(entry.conflictStatus ? { conflictStatus: entry.conflictStatus } : {}),
        ...(entry.added !== undefined ? { added: entry.added } : {}),
        ...(entry.removed !== undefined ? { removed: entry.removed } : {})
      })),
      conflictOperation: status.conflictOperation,
      ...(status.head ? { head: status.head } : {}),
      ...(status.branch ? { branch: status.branch } : {}),
      upstreamStatus: repository.upstream,
      didHitLimit: status.truncated,
      statusLength: status.totalCount
    }
  }
  if (method === 'git.upstreamStatus') {
    return (await client.sourceControlUpstream({ workspaceId })).upstream
  }
  if (method === 'git.localBranches') {
    const result = await client.sourceControlBranches({ workspaceId })
    return { current: result.current, branches: result.branches }
  }
  if (method === 'git.history') {
    const limit = safePositiveInteger(params.limit, 50)
    const baseRef = safeString(params.baseRef)
    const result = await client.sourceControlHistory({
      workspaceId,
      limit: Math.min(limit, 100),
      ...(baseRef ? { baseRef } : {})
    })
    return withoutWorkspaceId(result)
  }
  if (method === 'git.branchCompare') {
    const baseRef = requiredString(params.baseRef)
    return branchCompareResult(await readWebHostBranchCompare(client, workspaceId, baseRef))
  }
  if (method === 'git.commitCompare') {
    const commitId = requiredString(params.commitId)
    return commitCompareResult(await client.sourceControlCommitCompare({ workspaceId, commitId }))
  }
  if (method === 'worktree.show') {
    const [repository, reviewLink] = await Promise.all([
      client.sourceControlUpstream({ workspaceId }),
      client.sourceControlReviewLink({ workspaceId })
    ])
    return {
      worktree: {
        id: workspaceId,
        baseRef: reviewLink.baseRef ?? repository.baseRef ?? undefined,
        linkedPR: reviewLink.linkedGitHubPR,
        linkedGitLabMR: reviewLink.linkedGitLabMR,
        linkedBitbucketPR: reviewLink.linkedBitbucketPR,
        linkedAzureDevOpsPR: reviewLink.linkedAzureDevOpsPR,
        linkedGiteaPR: reviewLink.linkedGiteaPR
      }
    }
  }
  if (method === 'repo.list') {
    return { repos: [] }
  }
  return WEB_HOST_SOURCE_CONTROL_REQUEST_UNHANDLED
}

export const WEB_HOST_SOURCE_CONTROL_REQUEST_UNHANDLED = Symbol('source-control-unhandled')

function branchCompareResult(
  result: Awaited<ReturnType<MobileWebBridgeClient['sourceControlBranchCompare']>>
) {
  return {
    summary: {
      baseRef: result.baseRef,
      baseOid: result.baseOid,
      compareRef: result.compareRef,
      headOid: result.headOid,
      mergeBase: result.mergeBase,
      changedFiles: result.changedFiles,
      ...(result.commitsAhead !== undefined ? { commitsAhead: result.commitsAhead } : {}),
      status: result.status
    },
    entries: result.entries.map(compareEntry)
  }
}

async function readWebHostBranchCompare(
  client: MobileWebBridgeClient,
  workspaceId: string,
  baseRef: string
): Promise<MobileWebSourceControlBranchCompareResult> {
  const entries: MobileWebSourceControlBranchCompareResult['entries'] = []
  let offset = 0
  let expectedRevision: string | undefined
  let expectedTotalEntries: number | undefined
  for (;;) {
    const page = await client.sourceControlBranchCompare({
      workspaceId,
      baseRef,
      offset,
      limit: MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT,
      ...(expectedRevision ? { expectedRevision } : {})
    })
    if (expectedRevision && page.revision !== expectedRevision) {
      throw new Error('conflict')
    }
    expectedRevision = page.revision
    if (
      (expectedTotalEntries !== undefined && page.totalEntries !== expectedTotalEntries) ||
      entries.length + page.entries.length > MOBILE_WEB_SOURCE_CONTROL_COMPARE_MAX_ENTRIES ||
      entries.length + page.entries.length > page.totalEntries
    ) {
      throw new Error('invalid_message')
    }
    expectedTotalEntries = page.totalEntries
    entries.push(...page.entries)
    if (page.nextOffset === null) {
      if (entries.length !== expectedTotalEntries) {
        throw new Error('invalid_message')
      }
      return { ...page, offset: 0, totalEntries: entries.length, entries }
    }
    if (
      page.nextOffset !== offset + page.entries.length ||
      page.nextOffset > MOBILE_WEB_SOURCE_CONTROL_COMPARE_MAX_ENTRIES
    ) {
      throw new Error('invalid_message')
    }
    offset = page.nextOffset
  }
}

function commitCompareResult(
  result: Awaited<ReturnType<MobileWebBridgeClient['sourceControlCommitCompare']>>
) {
  return {
    summary: {
      commitOid: result.commitOid ?? result.commitId,
      parentOid: result.parentOid,
      compareRef: result.compareRef,
      baseRef: result.baseRef,
      changedFiles: result.changedFiles,
      status: result.status
    },
    entries: result.entries.map(compareEntry)
  }
}

function compareEntry(entry: {
  relativePath: string
  oldRelativePath?: string
  status: string
  added?: number
  removed?: number
}) {
  return {
    path: entry.relativePath,
    ...(entry.oldRelativePath ? { oldPath: entry.oldRelativePath } : {}),
    status: entry.status,
    ...(entry.added !== undefined ? { added: entry.added } : {}),
    ...(entry.removed !== undefined ? { removed: entry.removed } : {})
  }
}

function withoutWorkspaceId<T extends { workspaceId: string }>(value: T): Omit<T, 'workspaceId'> {
  const { workspaceId: _workspaceId, ...rest } = value
  return rest
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function requiredString(value: unknown): string {
  const result = safeString(value)
  if (!result) {
    throw new Error('invalid_request')
  }
  return result
}

function safePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}
