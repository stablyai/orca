import type { HostedReviewApproval, HostedReviewInfo } from '../../shared/hosted-review'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'
import {
  acquire,
  glabExecFileAsync,
  glabHostnameArgs,
  glabRepoExecOptions,
  release
} from './gl-utils'
import { getProjectSlug } from './merge-request-lookup'

/** One GraphQL read per repo refreshes approval for every open MR shown, at most this often. */
export const MR_APPROVAL_REFRESH_INTERVAL_MS = 30_000
// shortcut: tracks the 100 most recently shown MRs per repo (one GraphQL page); page if more are shown.
const MAX_TRACKED_IIDS = 100

type RepoApprovals = {
  repoPath: string
  connectionId: string | null
  options: HostedReviewExecutionOptions
  iids: Set<number>
  approvals: Map<number, HostedReviewApproval>
  fetchedAt: number
  refreshing: Promise<void> | null
}

const repos = new Map<string, RepoApprovals>()

type RawApprovalNode = {
  iid?: unknown
  approvalsRequired?: unknown
  approvalsLeft?: unknown
  approvedBy?: { nodes?: ({ id?: unknown } | null)[] } | null
  userPermissions?: { canApprove?: unknown } | null
} | null

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function parseApprovals(stdout: string): Map<number, HostedReviewApproval> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field read below is type-checked before use.
  const { data } = JSON.parse(stdout) as {
    data?: {
      currentUser?: { id?: unknown } | null
      project?: { mergeRequests?: { nodes?: RawApprovalNode[] } | null } | null
    }
  }
  const approvals = new Map<number, HostedReviewApproval>()
  const userId = data?.currentUser?.id
  if (typeof userId !== 'string') {
    return approvals
  }
  for (const node of data?.project?.mergeRequests?.nodes ?? []) {
    const iid = Number(node?.iid)
    const canApprove = node?.userPermissions?.canApprove
    // Why: a missing permission means unknown, never permission to approve.
    if (!node || !Number.isSafeInteger(iid) || typeof canApprove !== 'boolean') {
      continue
    }
    const approvers = node.approvedBy?.nodes ?? []
    approvals.set(iid, {
      approvalsRequired: nonNegativeInt(node.approvalsRequired),
      approvalsLeft: nonNegativeInt(node.approvalsLeft),
      approvedCount: approvers.length,
      userCanApprove: canApprove,
      userHasApproved: approvers.some((approver) => approver?.id === userId)
    })
  }
  return approvals
}

async function fetchApprovals(entry: RepoApprovals): Promise<Map<number, HostedReviewApproval>> {
  const projectRef = await getProjectSlug(entry.repoPath, entry.connectionId, entry.options)
  if (!projectRef || entry.iids.size === 0) {
    return new Map()
  }
  const iids = JSON.stringify([...entry.iids].map(String))
  const query = `query { currentUser { id } project(fullPath: ${JSON.stringify(projectRef.path)}) { mergeRequests(iids: ${iids}, first: ${MAX_TRACKED_IIDS}) { nodes { iid approvalsRequired approvalsLeft approvedBy { nodes { id } } userPermissions { canApprove } } } } }`
  await acquire()
  try {
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, entry.connectionId),
        'graphql',
        '-f',
        `query=${query}`
      ],
      glabRepoExecOptions(
        entry.repoPath,
        entry.connectionId,
        getHostedReviewLocalGitOptions(entry.options)
      )
    )
    return parseApprovals(stdout)
  } finally {
    release()
  }
}

function refresh(entry: RepoApprovals): Promise<void> {
  entry.refreshing ??= (async () => {
    let approvals = new Map<number, HostedReviewApproval>()
    try {
      approvals = await fetchApprovals(entry)
    } catch {
      // Best-effort: a failed read hides approval UI until the next interval.
    }
    entry.approvals = approvals
    entry.fetchedAt = Date.now()
    entry.refreshing = null
  })()
  return entry.refreshing
}

/** Attaches the last batched approval read and schedules the next one; never issues a request inline. */
export function withCachedGitLabApproval(
  review: HostedReviewInfo,
  repoPath: string,
  connectionId: string | null,
  options: HostedReviewExecutionOptions
): HostedReviewInfo {
  if (review.provider !== 'gitlab' || review.state !== 'open') {
    return review
  }
  const key = `${connectionId ?? ''}\0${repoPath}`
  let entry = repos.get(key)
  if (!entry) {
    entry = {
      repoPath,
      connectionId,
      options,
      iids: new Set(),
      approvals: new Map(),
      fetchedAt: 0,
      refreshing: null
    }
    repos.set(key, entry)
  }
  entry.options = options
  entry.iids.delete(review.number)
  entry.iids.add(review.number)
  if (entry.iids.size > MAX_TRACKED_IIDS) {
    entry.iids.delete(entry.iids.values().next().value ?? review.number)
  }
  if (!entry.refreshing && Date.now() - entry.fetchedAt >= MR_APPROVAL_REFRESH_INTERVAL_MS) {
    void refresh(entry)
  }
  const approval = entry.approvals.get(review.number)
  return approval ? { ...review, approval } : review
}

/** After approve/revoke, re-read now so the sidebar's follow-up refresh shows the change. */
export async function refreshGitLabApprovals(repoPath: string): Promise<void> {
  const matching = [...repos.values()].filter((entry) => entry.repoPath === repoPath)
  await Promise.all(
    matching.map(async (entry) => {
      // Why: an in-flight read may predate the mutation.
      await entry.refreshing
      await refresh(entry)
    })
  )
}

/** @internal - exposed for tests only */
export function __resetGitLabApprovalCacheForTests(): void {
  repos.clear()
}
