import type {
  AzureDevOpsPrCheck,
  AzureDevOpsPrFileChange,
  AzureDevOpsPrReviewer,
  AzureDevOpsPrSummary,
  AzureDevOpsPrThread,
  AzureDevOpsPullRequestStatus,
  AzureDevOpsVoteLabel
} from '../../../shared/azure-devops/azure-devops-pr-review-types'

type RawIdentity = {
  id?: string | null
  displayName?: string | null
  uniqueName?: string | null
} | null

export type RawReviewer = RawIdentity & {
  vote?: number | null
  isRequired?: boolean | null
  isContainer?: boolean | null
}

export type RawPullRequest = {
  pullRequestId?: number
  title?: string | null
  description?: string | null
  status?: string | null
  isDraft?: boolean | null
  creationDate?: string | null
  sourceRefName?: string | null
  targetRefName?: string | null
  mergeStatus?: string | null
  createdBy?: RawIdentity
  reviewers?: RawReviewer[] | null
  lastMergeSourceCommit?: { commitId?: string | null } | null
  lastMergeTargetCommit?: { commitId?: string | null } | null
  repository?: {
    id?: string | null
    name?: string | null
    project?: { id?: string | null; name?: string | null } | null
  } | null
}

export type RawThread = {
  id?: number
  status?: string | null
  isDeleted?: boolean | null
  threadContext?: {
    filePath?: string | null
    rightFileStart?: { line?: number | null } | null
    leftFileStart?: { line?: number | null } | null
  } | null
  comments?: {
    id?: number
    parentCommentId?: number | null
    commentType?: string | null
    isDeleted?: boolean | null
    content?: string | null
    publishedDate?: string | null
    author?: RawIdentity
  }[]
}

export type RawPolicyEvaluation = {
  status?: string | null
  configuration?: {
    isBlocking?: boolean | null
    isEnabled?: boolean | null
    type?: { displayName?: string | null } | null
    settings?: { displayName?: string | null } | null
  } | null
  context?: { buildId?: number | null; buildIsNotCurrent?: boolean | null } | null
}

export type RawPrStatus = {
  state?: string | null
  description?: string | null
  targetUrl?: string | null
  context?: { name?: string | null; genre?: string | null } | null
}

const VOTE_LABELS: Record<number, AzureDevOpsVoteLabel> = {
  10: 'approved',
  5: 'approved-with-suggestions',
  0: 'no-vote',
  [-5]: 'waiting-for-author',
  [-10]: 'rejected'
}

export function azureDevOpsVoteLabel(vote: number | null | undefined): AzureDevOpsVoteLabel {
  return VOTE_LABELS[vote ?? 0] ?? 'no-vote'
}

function shortBranch(ref: string | null | undefined): string {
  return (ref ?? '').replace(/^refs\/heads\//, '')
}

function pullRequestStatus(status: string | null | undefined): AzureDevOpsPullRequestStatus {
  return status === 'completed' || status === 'abandoned' ? status : 'active'
}

export function mapPullRequestSummary(
  raw: RawPullRequest,
  collectionWebUrl: string,
  myId: string | null
): AzureDevOpsPrSummary | null {
  const id = raw.pullRequestId
  const project = raw.repository?.project?.name
  const repository = raw.repository?.name
  if (typeof id !== 'number' || !project || !repository) {
    return null
  }
  const mine = myId ? raw.reviewers?.find((reviewer) => reviewer?.id === myId) : undefined
  return {
    id,
    title: raw.title ?? '',
    status: pullRequestStatus(raw.status),
    isDraft: raw.isDraft === true,
    project,
    repository,
    author: raw.createdBy?.displayName ?? null,
    createdDate: raw.creationDate ?? null,
    sourceBranch: shortBranch(raw.sourceRefName),
    targetBranch: shortBranch(raw.targetRefName),
    url: `${collectionWebUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${id}`,
    myVote: mine ? azureDevOpsVoteLabel(mine.vote) : null
  }
}

export function mapReviewers(
  reviewers: RawReviewer[] | null | undefined,
  myId: string | null
): AzureDevOpsPrReviewer[] {
  return (reviewers ?? []).flatMap((reviewer) =>
    reviewer?.displayName
      ? [
          {
            displayName: reviewer.displayName,
            uniqueName: reviewer.uniqueName ?? null,
            vote: reviewer.vote ?? 0,
            voteLabel: azureDevOpsVoteLabel(reviewer.vote),
            isRequired: reviewer.isRequired === true,
            isGroup: reviewer.isContainer === true,
            isMe: myId !== null && reviewer.id === myId
          }
        ]
      : []
  )
}

/** Human discussion only: system threads (votes, pushes, policy notes) and deleted ones are dropped. */
export function mapThreads(threads: RawThread[] | null | undefined): AzureDevOpsPrThread[] {
  return (threads ?? []).flatMap((thread) => {
    if (typeof thread.id !== 'number' || thread.isDeleted === true) {
      return []
    }
    const comments = (thread.comments ?? []).flatMap((comment) =>
      typeof comment.id === 'number' &&
      comment.isDeleted !== true &&
      comment.commentType !== 'system'
        ? [
            {
              id: comment.id,
              parentId: comment.parentCommentId ? comment.parentCommentId : null,
              author: comment.author?.displayName ?? null,
              publishedDate: comment.publishedDate ?? null,
              content: comment.content ?? ''
            }
          ]
        : []
    )
    if (comments.length === 0) {
      return []
    }
    const context = thread.threadContext
    return [
      {
        id: thread.id,
        status: thread.status && thread.status !== 'unknown' ? thread.status : null,
        filePath: context?.filePath ?? null,
        line: context?.rightFileStart?.line ?? context?.leftFileStart?.line ?? null,
        comments
      }
    ]
  })
}

export function mapChecks(
  evaluations: RawPolicyEvaluation[] | null | undefined,
  statuses: RawPrStatus[] | null | undefined,
  buildUrl: (buildId: number) => string
): AzureDevOpsPrCheck[] {
  const policies = (evaluations ?? []).flatMap((evaluation): AzureDevOpsPrCheck[] => {
    const config = evaluation.configuration
    if (!config || config.isEnabled === false) {
      return []
    }
    const typeName = config.type?.displayName ?? 'Policy'
    const buildId = evaluation.context?.buildId ?? null
    const isBuild = typeName === 'Build'
    return [
      {
        name: config.settings?.displayName || typeName,
        kind: isBuild ? 'build' : 'policy',
        status: evaluation.status ?? 'unknown',
        isBlocking: config.isBlocking === true,
        buildId,
        isStale: evaluation.context?.buildIsNotCurrent === true,
        url: buildId !== null ? buildUrl(buildId) : null
      }
    ]
  })
  const external = (statuses ?? []).map((status): AzureDevOpsPrCheck => ({
    name:
      [status.context?.genre, status.context?.name].filter(Boolean).join('/') ||
      status.description ||
      'status',
    kind: 'status',
    status: status.state ?? 'unknown',
    isBlocking: false,
    buildId: null,
    isStale: false,
    url: status.targetUrl ?? null
  }))
  return [...policies, ...external]
}

export function mapFileChanges(
  entries:
    | {
        changeType?: string | null
        item?: { path?: string | null } | null
        originalPath?: string | null
        sourceServerItem?: string | null
      }[]
    | null
    | undefined
): AzureDevOpsPrFileChange[] {
  return (entries ?? []).flatMap((entry) =>
    entry.item?.path
      ? [
          {
            path: entry.item.path,
            changeType: entry.changeType ?? 'edit',
            originalPath: entry.originalPath ?? entry.sourceServerItem ?? null
          }
        ]
      : []
  )
}
