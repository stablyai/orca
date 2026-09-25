import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { isFloatingWorkspaceId } from '../../shared/floating-workspace-worktree'

/**
 * Pin the directory a session's provider was launched in.
 *
 * First writer wins: the pin records where the session ran, so no later launch may move it — a
 * move would be an explicit act, not a side effect of resolving a workspace again.
 */
export function pinAgentSessionRecordWorkspacePath(
  record: AgentSessionRecord,
  workspacePath: string,
  now: number
): AgentSessionRecord {
  if (record.workspacePath !== undefined) {
    return record
  }
  return { ...record, workspacePath, updatedAt: now }
}

/**
 * The pinned directory a launch is held to, or undefined when the workspace id decides. Only the
 * floating id names a setting rather than a place, so only a floating session is held to its pin.
 */
export function agentSessionPinnedLaunchDirectory(record: AgentSessionRecord): string | undefined {
  return isFloatingWorkspaceId(record.location.workspaceId) ? record.workspacePath : undefined
}
