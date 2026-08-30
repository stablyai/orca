import {
  DASHBOARD_MAX_LABEL_LENGTH,
  DASHBOARD_MAX_MAP_WORKSPACES,
  type DashboardWorkspace
} from '../../shared/dashboard-snapshot'
import { normalizeExecutionHostId } from '../../shared/execution-host'
import { MAX_ID_LENGTH } from './dashboard-payload-primitives'
import { isDashboardReview } from './dashboard-review-payload-validation'

const HOST_KINDS = new Set(['local', 'ssh', 'wsl', 'remote'])
const WORKSPACE_KINDS = new Set(['worktree', 'folder'])

function isString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0)
}

function isOptionalString(value: unknown, maxLength: number): boolean {
  return value === undefined || isString(value, maxLength, true)
}

export function isDashboardWorkspace(value: unknown): value is DashboardWorkspace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const workspace = value as Record<string, unknown>
  return (
    isString(workspace.repoId, MAX_ID_LENGTH) &&
    isString(workspace.worktreeId, MAX_ID_LENGTH) &&
    isString(workspace.repoName, DASHBOARD_MAX_LABEL_LENGTH, true) &&
    isString(workspace.worktreeName, DASHBOARD_MAX_LABEL_LENGTH, true) &&
    isOptionalString(workspace.parentWorktreeId, MAX_ID_LENGTH) &&
    typeof workspace.hostKind === 'string' &&
    HOST_KINDS.has(workspace.hostKind) &&
    isString(workspace.executionHostId, MAX_ID_LENGTH) &&
    normalizeExecutionHostId(workspace.executionHostId) !== null &&
    isOptionalString(workspace.hostLabel, DASHBOARD_MAX_LABEL_LENGTH) &&
    typeof workspace.workspaceKind === 'string' &&
    WORKSPACE_KINDS.has(workspace.workspaceKind) &&
    isOptionalString(workspace.workspaceStatusId, MAX_ID_LENGTH) &&
    isOptionalString(workspace.workspaceStatusLabel, DASHBOARD_MAX_LABEL_LENGTH) &&
    isOptionalString(workspace.workspaceStatusColor, MAX_ID_LENGTH) &&
    (workspace.hasReview === undefined || typeof workspace.hasReview === 'boolean') &&
    isDashboardReview(workspace.review)
  )
}

export function isDashboardWorkspaceList(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= DASHBOARD_MAX_MAP_WORKSPACES &&
      value.every(isDashboardWorkspace))
  )
}

export function admitDashboardWorkspaces(value: unknown): DashboardWorkspace[] | undefined | null {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.length > DASHBOARD_MAX_MAP_WORKSPACES) {
    return null
  }
  return value.filter(isDashboardWorkspace)
}
