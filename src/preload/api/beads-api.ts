import type {
  BeadsIssue,
  BeadsIssueDetails,
  BeadsIssuePreset,
  BeadsIssueStatus,
  BeadsWorkspaceStatus
} from '../../shared/beads-types'

export type BeadsApi = {
  getStatus: (args: { repoId: string }) => Promise<{ status: BeadsWorkspaceStatus }>
  listIssues: (args: {
    repoId: string
    preset?: BeadsIssuePreset
    limit?: number
    /** beads-query-filter.v1 route: 'all' includes closed; 'ready' = bd ready. */
    statusScope?: 'open' | 'all' | 'ready'
    /** '@me' resolves to the repo host's actor. */
    assignee?: string
  }) => Promise<{ issues: BeadsIssue[]; status: BeadsWorkspaceStatus }>
  getIssue: (args: { repoId: string; id: string }) => Promise<{ issue: BeadsIssue | null }>
  /** Relations + comments; details:null when bd/workspace/issue is unavailable. */
  getIssueDetails: (args: {
    repoId: string
    id: string
  }) => Promise<{ details: BeadsIssueDetails | null }>
  /** Posts a comment, then resolves with the re-fetched details. */
  addComment: (args: {
    repoId: string
    id: string
    text: string
  }) => Promise<{ details: BeadsIssueDetails | null }>
  updateIssue: (args: {
    repoId: string
    id: string
    status: BeadsIssueStatus
  }) => Promise<{ issue: BeadsIssue | null; status: BeadsWorkspaceStatus }>
}
