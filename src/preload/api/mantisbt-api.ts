import type {
  MantisBTConnectionStatus,
  MantisBTIssue,
  MantisBTIssueFilter,
  MantisBTProject,
  MantisBTSiteSelection,
  MantisBTViewer
} from '../../shared/mantisbt-types'

export type MantisBTApi = {
  connect: (args: {
    siteUrl: string
    apiToken: string
  }) => Promise<{ ok: true; viewer: MantisBTViewer } | { ok: false; error: string }>
  disconnect: (args?: { siteId?: string }) => Promise<void>
  selectSite: (args: { siteId: MantisBTSiteSelection }) => Promise<MantisBTConnectionStatus>
  status: () => Promise<MantisBTConnectionStatus>
  testConnection: (args?: {
    siteId?: string
  }) => Promise<{ ok: true; viewer: MantisBTViewer } | { ok: false; error: string }>
  listIssues: (args?: {
    filter?: MantisBTIssueFilter
    limit?: number
    siteId?: MantisBTSiteSelection
    projectId?: string
    requestId?: string
  }) => Promise<MantisBTIssue[]>
  onListIssuesProgress: (
    callback: (data: { requestId: string; issues: MantisBTIssue[] }) => void
  ) => () => void
  getIssue: (args: { id: string; siteId?: string }) => Promise<MantisBTIssue | null>
  listProjects: (args?: { siteId?: MantisBTSiteSelection }) => Promise<MantisBTProject[]>
}
