import type {
  LinearAttachResult,
  LinearCommentAddResult,
  LinearCreateResult,
  LinearIssueContextResult,
  LinearIssueListResult,
  LinearIssueTaskUpdateResult,
  LinearProjectListResult,
  LinearSearchResult,
  LinearStatusSetResult,
  LinearTeamLabelsResult,
  LinearTeamListResult,
  LinearTeamMembersResult,
  LinearTeamStatesResult
} from '../../shared/linear-agent-access'

export function isLinearIssueContextResult(result: unknown): result is LinearIssueContextResult {
  return (
    isRecord(result) &&
    isRecord(result.issue) &&
    isRecord(result.meta) &&
    typeof result.issue.identifier === 'string' &&
    Array.isArray(result.issue.labels) &&
    Array.isArray(result.meta.includeErrors) &&
    isRecord(result.meta.sections)
  )
}

export function isLinearSearchResult(result: unknown): result is LinearSearchResult {
  return (
    isRecord(result) &&
    Array.isArray(result.issues) &&
    isRecord(result.meta) &&
    typeof result.meta.query === 'string' &&
    typeof result.meta.returned === 'number'
  )
}

export function isLinearIssueListResult(result: unknown): result is LinearIssueListResult {
  return (
    isRecord(result) &&
    Array.isArray(result.issues) &&
    isRecord(result.meta) &&
    typeof result.meta.filter === 'string' &&
    typeof result.meta.hasMore === 'boolean'
  )
}

export function isLinearProjectListResult(result: unknown): result is LinearProjectListResult {
  return (
    isRecord(result) &&
    Array.isArray(result.projects) &&
    result.projects.every(isLinearProjectListProject) &&
    isRecord(result.meta) &&
    typeof result.meta.limit === 'number' &&
    typeof result.meta.returned === 'number' &&
    typeof result.meta.hasMore === 'boolean' &&
    typeof result.meta.partial === 'boolean' &&
    Array.isArray(result.meta.workspaceErrors) &&
    result.meta.workspaceErrors.every(isLinearWorkspaceError)
  )
}

export function isLinearTeamListResult(result: unknown): result is LinearTeamListResult {
  return (
    isRecord(result) &&
    Array.isArray(result.teams) &&
    isRecord(result.meta) &&
    typeof result.meta.partial === 'boolean'
  )
}

export function isLinearTeamMembersResult(result: unknown): result is LinearTeamMembersResult {
  return isRecord(result) && isRecord(result.team) && Array.isArray(result.members)
}

export function isLinearTeamStatesResult(result: unknown): result is LinearTeamStatesResult {
  return isRecord(result) && isRecord(result.team) && Array.isArray(result.states)
}

export function isLinearTeamLabelsResult(result: unknown): result is LinearTeamLabelsResult {
  return isRecord(result) && isRecord(result.team) && Array.isArray(result.labels)
}

export function isLinearStatusSetResult(result: unknown): result is LinearStatusSetResult {
  return (
    isRecord(result) &&
    isRecord(result.issue) &&
    isRecord(result.state) &&
    isRecord(result.meta) &&
    typeof result.state.name === 'string' &&
    typeof result.meta.alreadyInState === 'boolean'
  )
}

export function isLinearTaskUpdateResult(result: unknown): result is LinearIssueTaskUpdateResult {
  return (
    isRecord(result) &&
    isRecord(result.issue) &&
    isRecord(result.meta) &&
    typeof result.operation === 'string' &&
    typeof result.meta.alreadySet === 'boolean'
  )
}

export function isLinearCommentAddResult(result: unknown): result is LinearCommentAddResult {
  return (
    isRecord(result) &&
    isRecord(result.comment) &&
    isRecord(result.issue) &&
    isRecord(result.meta) &&
    typeof result.comment.id === 'string' &&
    typeof result.meta.bodyChars === 'number'
  )
}

export function isLinearAttachResult(result: unknown): result is LinearAttachResult {
  return (
    isRecord(result) &&
    isRecord(result.attachment) &&
    isRecord(result.issue) &&
    isRecord(result.meta) &&
    typeof result.attachment.title === 'string' &&
    typeof result.attachment.url === 'string'
  )
}

export function isLinearCreateResult(result: unknown): result is LinearCreateResult {
  return (
    isRecord(result) &&
    isRecord(result.issue) &&
    isRecord(result.meta) &&
    typeof result.issue.identifier === 'string' &&
    typeof result.issue.title === 'string' &&
    typeof result.meta.writeId === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function isLinearProjectListProject(project: unknown): boolean {
  return (
    isRecord(project) &&
    typeof project.id === 'string' &&
    typeof project.name === 'string' &&
    (project.workspaceId === undefined || typeof project.workspaceId === 'string') &&
    (project.workspaceName === undefined || typeof project.workspaceName === 'string') &&
    (project.teams === undefined ||
      (Array.isArray(project.teams) && project.teams.every(isLinearProjectTeam)))
  )
}

function isLinearProjectTeam(team: unknown): boolean {
  return (
    isRecord(team) &&
    typeof team.id === 'string' &&
    typeof team.name === 'string' &&
    (team.key === undefined || typeof team.key === 'string')
  )
}

function isLinearWorkspaceError(error: unknown): boolean {
  return (
    isRecord(error) &&
    isRecord(error.workspace) &&
    typeof error.workspace.name === 'string' &&
    typeof error.code === 'string' &&
    typeof error.message === 'string'
  )
}
