import {
  DASHBOARD_MAX_LAUNCH_WORKTREES,
  type DashboardSpawnAgentArgs
} from '../../shared/dashboard-snapshot'
import { isTuiAgent } from '../../shared/tui-agent-config'

const MAX_ID_LENGTH = 4_096
const MAX_AGENTS_PER_WORKTREE = 64

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

export function isDashboardSpawnAgentArgs(value: unknown): value is DashboardSpawnAgentArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const args = value as Record<string, unknown>
  return isBoundedId(args.worktreeId) && isTuiAgent(args.agent)
}

export function isDashboardLaunchOptions(value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const entries = Object.entries(value as Record<string, unknown>)
  return (
    entries.length <= DASHBOARD_MAX_LAUNCH_WORKTREES &&
    entries.every(
      ([worktreeId, agents]) =>
        isBoundedId(worktreeId) &&
        Array.isArray(agents) &&
        agents.length <= MAX_AGENTS_PER_WORKTREE &&
        agents.every(isTuiAgent)
    )
  )
}
