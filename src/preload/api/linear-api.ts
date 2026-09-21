import type { LinearIssueAttributeFilter } from '../../shared/linear/issue-attribute-filter'
import type { LinearIssueUpdate } from '../../shared/issue-mutation-types'
import type { LinearComment, LinearIssue } from '../../shared/linear/issue-types'
import type {
  LinearCustomViewModel,
  LinearCustomViewSummary,
  LinearProjectDetail,
  LinearProjectSummary
} from '../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearConnectionStatus,
  LinearLabel,
  LinearMember,
  LinearTeam,
  LinearViewer,
  LinearWorkflowState,
  LinearWorkspaceSelection
} from '../../shared/linear/workspace-types'

export type LinearApi = {
  connect: (args: {
    apiKey: string
  }) => Promise<{ ok: true; viewer: LinearViewer } | { ok: false; error: string }>
  disconnect: (args?: { workspaceId?: string }) => Promise<void>
  selectWorkspace: (args: {
    workspaceId: LinearWorkspaceSelection
  }) => Promise<LinearConnectionStatus>
  status: () => Promise<LinearConnectionStatus>
  testConnection: (args?: {
    workspaceId?: string
  }) => Promise<{ ok: true; viewer: LinearViewer } | { ok: false; error: string }>
  searchIssues: (args: {
    query: string
    limit?: number
    workspaceId?: LinearWorkspaceSelection
  }) => Promise<LinearIssue[]>
  listIssues: (args?: {
    filter?: 'assigned' | 'created' | 'all' | 'completed'
    limit?: number
    workspaceId?: LinearWorkspaceSelection
    attributeFilter?: LinearIssueAttributeFilter
  }) => Promise<LinearCollectionResult<LinearIssue>>
  createIssue: (args: {
    teamId: string
    title: string
    description?: string
    workspaceId?: string
    parentIssueId?: string
    projectId?: string | null
    stateId?: string
    priority?: number
    assigneeId?: string | null
    labelIds?: string[]
  }) => Promise<
    | { ok: true; id: string; identifier: string; title: string; url: string }
    | { ok: false; error: string }
  >
  getIssue: (args: { id: string; workspaceId?: string }) => Promise<LinearIssue | null>
  updateIssue: (args: {
    id: string
    updates: LinearIssueUpdate
    workspaceId?: string
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  addIssueComment: (args: {
    issueId: string
    body: string
    workspaceId?: string
  }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
  issueComments: (args: { issueId: string; workspaceId?: string }) => Promise<LinearComment[]>
  listTeams: (args?: { workspaceId?: LinearWorkspaceSelection }) => Promise<LinearTeam[]>
  listProjects: (args?: {
    query?: string
    limit?: number
    workspaceId?: LinearWorkspaceSelection
    force?: boolean
  }) => Promise<LinearCollectionResult<LinearProjectSummary>>
  createProject: (args: {
    name: string
    description?: string
    content?: string
    teamIds: string[]
    workspaceId?: string
    leadId?: string | null
    memberIds?: string[]
    labelIds?: string[]
    priority?: number
    startDate?: string
    targetDate?: string
  }) => Promise<{ ok: true; project: LinearProjectDetail } | { ok: false; error: string }>
  getProject: (args: {
    id: string
    workspaceId: string
    force?: boolean
  }) => Promise<LinearProjectDetail | null>
  listProjectIssues: (args: {
    projectId: string
    limit?: number
    workspaceId: string
    force?: boolean
  }) => Promise<LinearCollectionResult<LinearIssue>>
  listCustomViews: (args: {
    model: LinearCustomViewModel
    limit?: number
    workspaceId?: LinearWorkspaceSelection
    force?: boolean
  }) => Promise<LinearCollectionResult<LinearCustomViewSummary>>
  getCustomView: (args: {
    viewId: string
    model: LinearCustomViewModel
    workspaceId: string
    force?: boolean
  }) => Promise<LinearCustomViewSummary | null>
  listCustomViewIssues: (args: {
    viewId: string
    limit?: number
    workspaceId: string
    force?: boolean
  }) => Promise<LinearCollectionResult<LinearIssue>>
  listCustomViewProjects: (args: {
    viewId: string
    limit?: number
    workspaceId: string
    force?: boolean
  }) => Promise<LinearCollectionResult<LinearProjectSummary>>
  teamStates: (args: { teamId: string; workspaceId?: string }) => Promise<LinearWorkflowState[]>
  teamLabels: (args: { teamId: string; workspaceId?: string }) => Promise<LinearLabel[]>
  teamMembers: (args: { teamId: string; workspaceId?: string }) => Promise<LinearMember[]>
}
