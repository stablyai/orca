import type { TaskSourceContext } from '../../shared/task-source-context'
import type {
  GiteaComment,
  GiteaConnectionStatus,
  GiteaCreateIssueResult,
  GiteaIssue,
  GiteaIssueUpdate,
  GiteaLabel,
  GiteaMergeMethod,
  GiteaMutationResult,
  GiteaPRCheck,
  GiteaPRFile,
  GiteaPRFileContents,
  GiteaPRFileStatus,
  GiteaPRReviewComment,
  GiteaPullRequestDetail,
  GiteaUser,
  GiteaViewer,
  GiteaWorkItem,
  GiteaWorkItemFilter
} from '../../shared/gitea-types'

export type GiteaApi = {
  connect: (args: {
    baseUrl: string
    token: string
  }) => Promise<{ ok: true; viewer: GiteaViewer } | { ok: false; error: string }>
  disconnect: (args?: { serverId?: string }) => Promise<void>
  selectServer: (args: { serverId: string }) => Promise<GiteaConnectionStatus>
  status: () => Promise<GiteaConnectionStatus>
  testConnection: (args?: {
    serverId?: string
  }) => Promise<{ ok: true; viewer: GiteaViewer } | { ok: false; error: string }>
  listWorkItems: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    filter?: GiteaWorkItemFilter
    limit?: number
  }) => Promise<GiteaWorkItem[]>
  issue: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    number: number
  }) => Promise<GiteaIssue | null>
  issueComments: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    number: number
  }) => Promise<GiteaComment[]>
  labels: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
  }) => Promise<GiteaLabel[]>
  assignees: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
  }) => Promise<GiteaUser[]>
  prDetail: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    number: number
  }) => Promise<GiteaPullRequestDetail | null>
  prFiles: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    number: number
  }) => Promise<GiteaPRFile[]>
  prFileContents: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    path: string
    oldPath?: string
    status: GiteaPRFileStatus
    baseSha: string
    headSha: string
  }) => Promise<GiteaPRFileContents>
  prChecks: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    headSha: string
  }) => Promise<GiteaPRCheck[]>
  prMerge: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    number: number
    method?: GiteaMergeMethod
  }) => Promise<GiteaMutationResult>
  prReviewComments: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    number: number
  }) => Promise<GiteaPRReviewComment[]>
  prAddReviewComment: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    number: number
    path: string
    line: number
    body: string
  }) => Promise<GiteaMutationResult>
  createIssue: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    title: string
    body?: string
    assignees?: string[]
    labelIds?: number[]
  }) => Promise<GiteaCreateIssueResult>
  updateIssue: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    number: number
    updates: GiteaIssueUpdate
  }) => Promise<GiteaMutationResult>
  addIssueComment: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    number: number
    body: string
  }) => Promise<GiteaMutationResult>
}
