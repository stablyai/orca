import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { isFloatingWorkspaceId } from '../../shared/floating-workspace-worktree'

/** First pin wins: resolving workspace settings again must not silently move an existing conversation. */
export function pinAgentSessionRecordLaunchDirectory(
  record: AgentSessionRecord,
  launchDirectory: string,
  now: number
): AgentSessionRecord {
  if (record.launchDirectory !== undefined) {
    return record
  }
  return { ...record, launchDirectory, updatedAt: now }
}

/** Only floating ids need pinned paths; worktree/folder ids already name durable places. */
export function agentSessionPinnedLaunchDirectory(
  record: Pick<AgentSessionRecord, 'launchDirectory' | 'location'>
): string | undefined {
  return isFloatingWorkspaceId(record.location.workspaceId) ? record.launchDirectory : undefined
}
