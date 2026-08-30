import {
  DASHBOARD_MAX_FILE_LINK_PATH_LENGTH,
  type DashboardOpenFileArgs
} from '../../shared/dashboard-snapshot'
import { normalizeExecutionHostId } from '../../shared/execution-host'

const MAX_ID_LENGTH = 4_096

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0)
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value > 0)
}

export function isDashboardOpenFileArgs(value: unknown): value is DashboardOpenFileArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const args = value as Record<string, unknown>
  return (
    // A folder-workspace card can carry no worktree id; the path still routes.
    isBoundedString(args.worktreeId, MAX_ID_LENGTH, true) &&
    (args.executionHostId === undefined ||
      (isBoundedString(args.executionHostId, MAX_ID_LENGTH) &&
        normalizeExecutionHostId(args.executionHostId) !== null)) &&
    isBoundedString(args.path, DASHBOARD_MAX_FILE_LINK_PATH_LENGTH) &&
    isOptionalPositiveInteger(args.line) &&
    isOptionalPositiveInteger(args.column) &&
    (args.openWithSystemDefault === undefined || typeof args.openWithSystemDefault === 'boolean')
  )
}
