import type {
  YouTrackAddCommentResult,
  YouTrackCommentsResult,
  YouTrackConnectionStatus,
  YouTrackConnectResult,
  YouTrackCreateIssueArgs,
  YouTrackProjectFieldsResult,
  YouTrackProjectsResult,
  YouTrackUpdateFieldArgs,
  YouTrackIssueResult,
  YouTrackListIssuesArgs,
  YouTrackListIssuesResult,
  YouTrackStateOption,
  YouTrackStateOptionsResult
} from '../../shared/youtrack-types'

export type YouTrackApi = {
  status: () => Promise<YouTrackConnectionStatus>
  connect: (args: {
    baseUrl: string
    token: string
    allowInsecureTls?: boolean
  }) => Promise<YouTrackConnectResult>
  disconnect: () => Promise<void>
  testConnection: () => Promise<YouTrackConnectResult>
  listIssues: (args?: YouTrackListIssuesArgs) => Promise<YouTrackListIssuesResult>
  getIssue: (args: { idReadable: string }) => Promise<YouTrackIssueResult>
  getComments: (args: { idReadable: string }) => Promise<YouTrackCommentsResult>
  addComment: (args: { idReadable: string; text: string }) => Promise<YouTrackAddCommentResult>
  getStateOptions: (args: { idReadable: string }) => Promise<YouTrackStateOptionsResult>
  setState: (args: {
    idReadable: string
    option: YouTrackStateOption
  }) => Promise<YouTrackIssueResult>
  listProjects: (args?: { force?: boolean }) => Promise<YouTrackProjectsResult>
  getProjectFields: (args: {
    projectId: string
    force?: boolean
  }) => Promise<YouTrackProjectFieldsResult>
  updateField: (args: YouTrackUpdateFieldArgs) => Promise<YouTrackIssueResult>
  createIssue: (args: YouTrackCreateIssueArgs) => Promise<YouTrackIssueResult>
}
