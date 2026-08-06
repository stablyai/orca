import type { HostedReviewDecision } from '../../../src/shared/hosted-review'
import type { GitHubOwnerRepo, ProviderCheckSummary } from '../../../src/shared/types'
import type { RpcClient } from '../transport/rpc-client'
import type { LinearMobileIssue } from './linear-mobile-issue-read'

export type RepoSummary = {
  id: string
  displayName: string
  path: string
  badgeColor?: string
  kind?: 'git' | 'folder'
  connectionId?: string | null
  issueSourcePreference?: IssueSourcePreference
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

export type GitLabTodo = {
  id: number
  actionName: string
  targetType: string
  targetIid: number | null
  targetTitle: string
  targetUrl: string
  projectPath: string
  authorUsername: string
  updatedAt: string
  state: 'pending' | 'done'
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
  reactions?: {
    content:
      | 'thumbs_up'
      | 'thumbs_down'
      | 'laugh'
      | 'confused'
      | 'heart'
      | 'hooray'
      | 'rocket'
      | 'eyes'
    count: number
  }[]
  path?: string
  line?: number
  startLine?: number
  threadId?: string
  isResolved?: boolean
}

export type GitHubDetailFile = {
  path: string
  oldPath?: string
  status?: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  additions?: number
  deletions?: number
  isBinary?: boolean
  viewerViewedState?: 'DISMISSED' | 'VIEWED' | 'UNVIEWED'
}

export type GitHubDetailCheck = {
  name: string
  status: string
  conclusion?: string | null
  url?: string | null
}

export type GitHubPRFileContents = {
  original: string
  modified: string
  originalIsBinary: boolean
  modifiedIsBinary: boolean
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
      pipelineJobs: {
        id?: number
        name: string
        stage: string
        status: string
        webUrl?: string | null
        duration?: number | null
      }[]
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
