import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'

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

/** Floating chats pin their folder because settings can move it; a chat adopted from a sub-folder
 *  pins that folder. Other chats resolve their workspace id. */
export function agentSessionPinnedLaunchDirectory(
  record: Pick<AgentSessionRecord, 'launchDirectory'>
): string | undefined {
  return record.launchDirectory
}
