import type {
  ItsaplanComment,
  ItsaplanConnectionStatus,
  ItsaplanCreateIssueArgs,
  ItsaplanIssue,
  ItsaplanIssueDetail,
  ItsaplanIssueListQuery,
  ItsaplanIssueUpdate,
  ItsaplanProject,
  ItsaplanProjectMetadata,
  ItsaplanResult,
  ItsaplanViewer
} from '../../../shared/itsaplan/itsaplan-types'

// Read methods throw an Error whose message starts with the failure code; mutations return ItsaplanFailure.
export type ItsaplanApi = {
  detectApiUrl: (args: {
    appUrl: string
  }) => Promise<ItsaplanResult<{ appUrl: string; apiUrl: string }>>
  connect: (args: {
    appUrl: string
    apiUrl?: string
    apiKey: string
  }) => Promise<ItsaplanResult<{ viewer: ItsaplanViewer }>>
  disconnect: () => Promise<void>
  status: () => Promise<ItsaplanConnectionStatus>
  testConnection: () => Promise<ItsaplanResult<{ viewer: ItsaplanViewer }>>
  listProjects: (args?: { query?: string }) => Promise<ItsaplanProject[]>
  getProjectMetadata: (args: { projectRef: string }) => Promise<ItsaplanProjectMetadata>
  listIssues: (args: ItsaplanIssueListQuery) => Promise<ItsaplanIssue[]>
  getIssue: (args: { issueId: number; projectRef?: string }) => Promise<ItsaplanIssueDetail | null>
  createIssue: (args: ItsaplanCreateIssueArgs) => Promise<ItsaplanResult<{ issue: ItsaplanIssue }>>
  updateIssue: (args: {
    issueId: number
    projectRef?: string
    updates: ItsaplanIssueUpdate
  }) => Promise<ItsaplanResult<{ issue: ItsaplanIssue }>>
  addComment: (args: {
    issueId: number
    body: string
  }) => Promise<ItsaplanResult<{ comment: ItsaplanComment }>>
}
