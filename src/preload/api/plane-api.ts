import type {
  PlaneComment,
  PlaneConnectArgs,
  PlaneConnectionStatus,
  PlaneIssue,
  PlaneIssueFilter,
  PlaneIssueUpdate,
  PlaneMutationResult,
  PlaneProject,
  PlaneState,
  PlaneViewer
} from '../../shared/plane-types'

export type PlaneApi = {
  connect: (
    args: PlaneConnectArgs
  ) => Promise<{ ok: true; viewer: PlaneViewer } | { ok: false; error: string }>
  disconnect: () => Promise<PlaneConnectionStatus>
  status: () => Promise<PlaneConnectionStatus>
  testConnection: () => Promise<{ ok: boolean; error?: string }>
  selectWorkspace: (args: { workspaceSlug: string }) => Promise<PlaneConnectionStatus>
  listProjects: (args?: { workspaceSlug?: string }) => Promise<PlaneProject[]>
  listStates: (args: { workspaceSlug: string; projectId: string }) => Promise<PlaneState[]>
  listIssues: (args?: {
    workspaceSlug?: string
    projectId?: string
    filter?: PlaneIssueFilter
    limit?: number
  }) => Promise<PlaneIssue[]>
  getIssue: (args: {
    workspaceSlug: string
    projectId: string
    issueId: string
  }) => Promise<PlaneIssue | null>
  updateIssue: (args: {
    workspaceSlug: string
    projectId: string
    issueId: string
    update: PlaneIssueUpdate
  }) => Promise<PlaneMutationResult>
  getIssueComments: (args: {
    workspaceSlug: string
    projectId: string
    issueId: string
  }) => Promise<PlaneComment[]>
  addIssueComment: (args: {
    workspaceSlug: string
    projectId: string
    issueId: string
    comment: string
  }) => Promise<PlaneMutationResult>
}
