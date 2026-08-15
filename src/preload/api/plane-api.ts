import type {
  PlaneCollectionResult,
  PlaneComment,
  PlaneConnectArgs,
  PlaneConnectionStatus,
  PlaneCreateIssueArgs,
  PlaneCycle,
  PlaneEstimate,
  PlaneIssueAttachment,
  PlaneIssueLink,
  PlaneIssueUpdate,
  PlaneLabel,
  PlaneListFilter,
  PlaneMember,
  PlaneModule,
  PlaneProject,
  PlaneState,
  PlaneViewer,
  PlaneWorkItemType,
  PlaneWorkItem
} from '../../shared/plane/types'

export type PlaneApi = {
  connect: (args: PlaneConnectArgs) => Promise<{ ok: true; viewer: PlaneViewer } | { ok: false; error: string }>
  disconnect: (args?: { instanceId?: string }) => Promise<void>
  selectInstance: (args: { instanceId: string }) => Promise<PlaneConnectionStatus>
  status: () => Promise<PlaneConnectionStatus>
  testConnection: (args?: { instanceId?: string }) => Promise<{ ok: true; viewer: PlaneViewer } | { ok: false; error: string }>
  listProjects: (args?: { instanceId?: string }) => Promise<PlaneProject[]>
  listStates: (args: { projectId: string; instanceId?: string }) => Promise<PlaneState[]>
  listLabels: (args: { projectId: string; instanceId?: string }) => Promise<PlaneLabel[]>
  listMembers: (args?: { instanceId?: string }) => Promise<PlaneMember[]>
  listCycles: (args: { projectId: string; instanceId?: string }) => Promise<PlaneCycle[]>
  listModules: (args: { projectId: string; instanceId?: string }) => Promise<PlaneModule[]>
  listWorkItemTypes: (args: { projectId: string; instanceId?: string }) => Promise<PlaneWorkItemType[]>
  listEstimates: (args: { projectId: string; instanceId?: string }) => Promise<PlaneEstimate[]>
  searchIssues: (args: { query: string; limit?: number; instanceId?: string }) => Promise<PlaneWorkItem[]>
  listIssues: (args?: { filter?: PlaneListFilter; limit?: number; instanceId?: string }) => Promise<PlaneCollectionResult<PlaneWorkItem>>
  getIssue: (args: { id: string; instanceId?: string }) => Promise<PlaneWorkItem | null>
  createIssue: (args: PlaneCreateIssueArgs) => Promise<{ ok: true; id: string; identifier: string; title: string; url: string } | { ok: false; error: string }>
  updateIssue: (args: { id: string; updates: PlaneIssueUpdate; instanceId?: string }) => Promise<{ ok: true } | { ok: false; error: string }>
  deleteIssue: (args: { id: string; instanceId?: string }) => Promise<{ ok: true } | { ok: false; error: string }>
  addIssueComment: (args: { id: string; body: string; instanceId?: string }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
  issueComments: (args: { id: string; instanceId?: string }) => Promise<PlaneComment[]>
  issueLinks: (args: { id: string; instanceId?: string }) => Promise<PlaneIssueLink[]>
  addIssueLink: (args: { id: string; title: string; url: string; instanceId?: string }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
  issueAttachments: (args: { id: string; instanceId?: string }) => Promise<PlaneIssueAttachment[]>
}
