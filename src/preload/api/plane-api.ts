import type {
  PlaneComment,
  PlaneConnectArgs,
  PlaneConnectionStatus,
  PlaneCreateWorkItemArgs,
  PlaneCreateWorkItemResult,
  PlaneLabel,
  PlaneMember,
  PlaneMutationResult,
  PlaneProject,
  PlaneState,
  PlaneViewer,
  PlaneWorkItem,
  PlaneWorkItemSearchResult,
  PlaneWorkItemUpdate,
  PlaneWorkspace,
  PlaneWorkspaceSelection
} from '../../shared/plane-types'

/** Work item reads and writes are scoped to a project the renderer already read. */
type ProjectScoped = { project: PlaneProject; workspaceId?: string }

export type PlaneApi = {
  connect: (
    args: PlaneConnectArgs
  ) => Promise<
    { ok: true; viewer: PlaneViewer; workspace: PlaneWorkspace } | { ok: false; error: string }
  >
  disconnect: (args?: { workspaceId?: string }) => Promise<{ ok: true }>
  status: () => Promise<PlaneConnectionStatus>
  selectWorkspace: (args: {
    workspaceId: PlaneWorkspaceSelection
  }) => Promise<PlaneConnectionStatus>
  testConnection: (args?: {
    workspaceId?: string
  }) => Promise<{ ok: true; viewer: PlaneViewer } | { ok: false; error: string }>

  listProjects: (args?: { workspaceId?: string }) => Promise<PlaneProject[]>
  listStates: (args: { projectId: string; workspaceId?: string }) => Promise<PlaneState[]>
  listLabels: (args: { projectId: string; workspaceId?: string }) => Promise<PlaneLabel[]>
  listMembers: (args?: { workspaceId?: string }) => Promise<PlaneMember[]>

  listWorkItems: (
    args: ProjectScoped & { orderBy?: string; limit?: number }
  ) => Promise<{ items: PlaneWorkItem[]; truncated: boolean }>
  getWorkItem: (args: {
    key: string
    workspaceId?: string
    project?: PlaneProject
  }) => Promise<PlaneWorkItem | null>
  searchWorkItems: (args: {
    search: string
    limit?: number
    projectId?: string
    workspaceId?: string
    requestId?: string
  }) => Promise<PlaneWorkItemSearchResult[]>
  cancelSearchWorkItems: (args: { requestId: string }) => Promise<void>

  workItemComments: (args: ProjectScoped & { workItemId: string }) => Promise<PlaneComment[]>
  updateWorkItem: (
    args: ProjectScoped & { workItemId: string; updates: PlaneWorkItemUpdate }
  ) => Promise<PlaneMutationResult>
  addComment: (
    args: ProjectScoped & { workItemId: string; body: string }
  ) => Promise<PlaneMutationResult>
  createWorkItem: (
    args: ProjectScoped & Omit<PlaneCreateWorkItemArgs, 'projectId' | 'workspaceId'>
  ) => Promise<PlaneCreateWorkItemResult>
}
