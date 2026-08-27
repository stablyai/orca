import type { DashboardStopAgentArgs } from '../../shared/dashboard-snapshot'

const MAX_ID_LENGTH = 4_096

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

export function isDashboardStopAgentArgs(value: unknown): value is DashboardStopAgentArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const args = value as Record<string, unknown>
  return (
    isBoundedId(args.paneKey) &&
    isBoundedId(args.worktreeId) &&
    isBoundedId(args.tabId) &&
    (args.leafId === null || isBoundedId(args.leafId)) &&
    (args.ptyId === null || isBoundedId(args.ptyId))
  )
}
