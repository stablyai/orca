import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { LinearIssueSummary } from '../../shared/linear/agent-access'

export { randomUUID } from 'node:crypto'
export { resolve } from 'node:path'
export type { RuntimeClientEvent } from '../../shared/runtime-client-events'
export type {
  LinearCurrentIssueContextHints,
  LinearAttachResult,
  LinearCommentAddResult,
  LinearCreateResult,
  LinearErrorCode,
  LinearIssueListFilter,
  LinearIssueListResult,
  LinearProjectListResult,
  LinearIssueRequest,
  LinearIssueSummary,
  LinearIssueTaskUpdateRequest,
  LinearIssueTaskUpdateResult,
  LinearMcpIssueListRequest,
  LinearMcpIssueListResult,
  LinearIssueRelationWriteRequest,
  LinearIssueRelationWriteResult,
  LinearSaveIssueRequest,
  LinearSaveIssueResult,
  LinearTeamLabelsResult,
  LinearTeamListResult,
  LinearTeamMembersResult,
  LinearTeamStatesResult,
  LinearStatusSetResult
} from '../../shared/linear/agent-access'
export type { LinearIssueUpdate } from '../../shared/issue-mutation-types'
export type { LinearProjectSummary } from '../../shared/linear/project-types'
export type { LinearWorkspaceSelection } from '../../shared/linear/workspace-types'
export {
  LINEAR_SEARCH_MAX_LIMIT,
  LINEAR_WRITE_BODY_CAP,
  clampLinearSearchLimit
} from '../../shared/linear/agent-access'
export { clampLinearIssueListLimit } from '../../shared/linear/issue-read-limits'
export { isLinearUuid } from '../../shared/linear/uuid'
export { isPathInsideOrEqual } from '../../shared/cross-platform-path'
export {
  connect as connectLinear,
  disconnect as disconnectLinear,
  getStatus as getLinearStatus,
  isAuthError as isLinearAuthError,
  selectWorkspace as selectLinearWorkspace,
  testConnection as testLinearConnection
} from '../linear/client'
export {
  addIssueComment as addLinearIssueComment,
  addIssueCommentForAgent as addLinearIssueCommentForAgent,
  createIssueAttachment as createLinearIssueAttachment
} from '../linear/linear-issue-comments'
export {
  createIssueForAgent as createLinearIssueForAgent,
  createIssue as createLinearIssue,
  updateIssueForAgent as updateLinearIssueForAgent,
  updateIssue as updateLinearIssue
} from '../linear/linear-issue-mutations'
export {
  getAttachmentByUuidForAgent as getLinearAttachmentByUuidForAgent,
  getCommentByUuidForAgent as getLinearCommentByUuidForAgent,
  getIssue as getLinearIssue,
  getIssueByUuidForAgent as getLinearIssueByUuidForAgent,
  getIssueCommentThreadRoot as getLinearIssueCommentThreadRoot,
  searchIssues as searchLinearIssues
} from '../linear/linear-issue-lookups'
export {
  listIssues as listLinearIssues,
  type LinearListFilter
} from '../linear/linear-issue-listing'
export type { LinearIssueListOptions } from '../linear/linear-issue-query-documents'
export { LinearWriteFailure } from '../linear/linear-issue-write-support'
export {
  LinearAgentAccessError,
  getLinearCurrentIssueFromWorktree,
  readLinearIssueContext,
  resolveLegacyLinearLinkWorkspace,
  searchLinearIssuesForAgents
} from '../linear/issue-context'
export {
  classifyLinearError,
  linearError,
  linearMessage,
  sanitizeLinearErrorMessage
} from '../linear/issue-context-errors'
export { listMcpIssues } from '../linear/mcp-issue-list'
export { writeIssueRelation } from '../linear/issue-relation-write'
export {
  getProject as getLinearProject,
  listProjectsByExactName as listLinearProjectsByExactName,
  listProjectTeams as listLinearProjectTeams,
  listProjects as listLinearProjects
} from '../linear/projects'
export {
  getTeamLabelsOrThrow as getLinearTeamLabelsOrThrow,
  getTeamMembersOrThrow as getLinearTeamMembersOrThrow,
  getTeamStatesOrThrow as getLinearTeamStatesOrThrow,
  getViewerForWorkspaceOrThrow as getLinearViewerForWorkspaceOrThrow,
  listTeamsForAgent as listLinearTeamsForAgent,
  listTeamsOrThrow as listLinearTeamsOrThrow
} from '../linear/teams'

export type LinearAgentWriteTarget = {
  issue: LinearIssueSummary
  workspaceId: string
}

export type LinearCreateFieldIntent = {
  stateId?: string
  assigneeId?: string | null
  priority?: number
  estimate?: number | null
  dueDate?: string | null
  labelIds?: string[]
  projectId?: string
}

export type LinearLinkedIssueUpdatedEvent = Extract<
  RuntimeClientEvent,
  { type: 'linearLinkedIssueUpdated' }
>

export function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false
  }
  const rightSet = new Set(right)
  return left.every((value) => rightSet.has(value))
}

export function labelsForIds(
  ids: string[],
  labels: { id?: string | null; name?: string | null; color?: string | null }[]
): { id: string; name: string; color?: string | null }[] {
  return ids.map((id) => {
    const label = labels.find((candidate) => candidate.id === id)
    return { id, name: label?.name ?? id, ...(label?.color ? { color: label.color } : {}) }
  })
}
