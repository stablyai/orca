import type {
  ProviderCheckSummary,
  GitHubOwnerRepo,
  RpcClient,
  HostedReviewDecision,
  LinearMobileIssue
} from './mobile-tasks-dependencies'

export type RepoSummary = {
  id: string
  displayName: string
  path: string
  badgeColor?: string
  kind?: 'git' | 'folder'
  connectionId?: string | null
  issueSourcePreference?: IssueSourcePreference
  /** Fork parent resolved by the host; drives upstream Project row matching. */
  upstream?: { owner: string; repo: string; host?: string } | null
}

export type IssueSourcePreference = 'upstream' | 'origin' | 'auto'

export type GitHubWorkItem = {
  id: string
  type: 'issue' | 'pr'
  number: number
  title: string
  state: 'open' | 'closed' | 'merged' | 'draft'
  url: string
  labels: string[]
  updatedAt: string
  author: string | null
  branchName?: string
  baseRefName?: string
  isCrossRepository?: boolean
  additions?: number
  deletions?: number
  changedFiles?: number
  repoId: string
  repoName: string
  reviewDecision?: string | null
  reviewRequests?: GitHubAssignableUser[]
  latestReviews?: GitHubPRReviewSummary[]
  checksSummary?: ProviderCheckSummary
  mergeable?: GitHubPRMergeableState
  mergeStateStatus?: string | null
}

export type GitHubAssignableUser = {
  login: string
  name?: string | null
  avatarUrl?: string | null
}

export type GitHubPRReviewSummary = {
  login: string
  state?: string | null
  avatarUrl?: string | null
}

export type GitHubPRMergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

export type GitHubPRReviewerRow = {
  login: string
  name?: string | null
  avatarUrl?: string | null
  stateLabel: string
}

export type GitHubRepoSources = {
  issues: GitHubOwnerRepo | null
  prs: GitHubOwnerRepo | null
  upstreamCandidate: GitHubOwnerRepo | null
}

export type TaskRuntimeStatus = {
  capabilities?: string[]
}

export type TasksSupportState =
  | { kind: 'unknown'; client: RpcClient | null }
  | { kind: 'supported'; client: RpcClient }
  | { kind: 'unsupported'; client: RpcClient }

export type GitLabWorkItem = {
  id: string
  type: 'issue' | 'mr'
  number: number
  title: string
  state: 'opened' | 'closed' | 'merged' | 'locked' | 'draft'
  url: string
  labels: string[]
  updatedAt: string
  author: string | null
  branchName?: string
  baseRefName?: string
  isCrossRepository?: boolean
  projectRef?: { host: string; path: string }
  checksSummary?: ProviderCheckSummary
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  reviewDecision?: HostedReviewDecision
  reviewerCount?: number
  repoId: string
  repoName: string
}

/**
 * A to-do as the reader proves it, not as the host declares it: the five members the screen reads
 * with no guard are required, and the rest are optional because a guard already stands in front of
 * each one. See `gitlabTodoSchema` in task-list-reply-schema.ts.
 */
export type GitLabTodo = {
  id: number
  actionName: string
  targetType?: string
  targetIid?: number | null
  targetTitle?: string
  targetUrl: string
  projectPath: string
  authorUsername?: string
  updatedAt: string
  state?: 'pending' | 'done'
}

export type GitPushTarget = {
  remoteName: string
  branchName: string
  remoteUrl?: string
}

export type SetupDecision = 'inherit' | 'run' | 'skip'

export type SetupRunPolicy = 'ask' | 'run-by-default' | 'skip-by-default'

export type RepoHooksResponse = {
  hooks: { scripts?: { setup?: string } } | null
  source: string | null
  setupRunPolicy?: SetupRunPolicy
  setupTrust?: {
    contentHash: string
    scriptContent: string
  }
}

export type LinearProject = {
  id: string
  name: string
  url?: string
  color?: string
}

export type LinearIssueChild = {
  id: string
  identifier: string
  title: string
  url: string
}

export type LinearIssue = LinearMobileIssue

export type LinearState = {
  id: string
  name: string
  type: string
  color?: string
}

export type LinearTeam = {
  id: string
  workspaceId?: string
  workspaceName?: string
  name: string
  key: string
}

export type DetailComment = {
  id: string | number
  author?: string
  authorAvatarUrl?: string
  user?: { displayName?: string }
  isBot?: boolean
  body: string
  createdAt?: string
  url?: string
  /**
   * `content` is whatever the provider called the reaction — GitHub's `GitHubReactionContent`
   * (`'+1'`, `'-1'`, `laugh`, ...) and absent on GitLab, whose rows are `{ name, count }`. It was
   * declared as an eight-arm mobile vocabulary no producer sends; `COMMENT_REACTION_EMOJI` is
   * keyed by that same vocabulary and so resolves no glyph for a real reaction, which is a
   * separate defect this type must not hide.
   */
  reactions?: Array<{
    content?: string
    count: number
  }>
  path?: string
  line?: number
  startLine?: number
  threadId?: string
  isResolved?: boolean
}

/** `viewerViewedState` is `string`, not `GitHubPRFileViewedState`'s three arms: the reader forwards
 *  whatever arrives so an arm this build predates reaches the `=== 'VIEWED'` tests as itself.
 *  `status` keeps the host's seven arms because its only consumer sends it back as a
 *  `github.prFileContents` param, which the host validates against that same set. */
export type GitHubDetailFile = {
  path: string
  oldPath?: string
  status?: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  additions?: number
  deletions?: number
  isBinary?: boolean
  viewerViewedState?: string
}

export type GitHubDetailCheck = {
  name: string
  status: string
  conclusion?: string | null
  url?: string | null
}

/** Optional throughout because nothing reads a member unguarded: the review panels reach each flag
 *  through `?.`, and `splitContentLines` (github-pr-file-diff.ts:21) takes `string | undefined`
 *  behind a falsy guard. The host sets the two too-large flags only when it skipped a side for size
 *  (pull-request-file-contents.ts:54), so they are absent on an ordinary reply. */
export type GitHubPRFileContents = {
  original?: string
  modified?: string
  originalIsBinary?: boolean
  modifiedIsBinary?: boolean
  originalTooLarge?: boolean
  modifiedTooLarge?: boolean
}

export type DetailPayload =
  | {
      provider: 'github'
      body: string
      comments: DetailComment[]
      labels: string[]
      assignees: string[]
      reviewDecision?: string | null
      reviewRequests: GitHubAssignableUser[]
      latestReviews: GitHubPRReviewSummary[]
      headSha?: string
      baseSha?: string
      pullRequestId?: string
      checks: GitHubDetailCheck[]
      files: GitHubDetailFile[]
    }
  | {
      provider: 'gitlab'
      body: string
      comments: DetailComment[]
      labels: string[]
      assignees: string[]
      pipelineJobs: Array<{
        id?: number
        name: string
        stage: string
        status: string
        webUrl?: string | null
        duration?: number | null
      }>
    }
  | {
      provider: 'linear'
      description: string
      comments: DetailComment[]
      labels: string[]
      assignee?: string
      project?: LinearProject
      children: LinearIssueChild[]
    }
  | {
      provider: 'jira'
      description: string
      comments: DetailComment[]
      labels: string[]
      assignee?: string
      projectName: string
      issueTypeName: string
      priorityName?: string
    }

export function detailPayloadBody(payload: DetailPayload): string {
  return payload.provider === 'linear' || payload.provider === 'jira'
    ? payload.description
    : payload.body
}
