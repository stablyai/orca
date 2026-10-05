import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { preserveTerminalRetirementProofs } from './mobile-session-terminal-retirement-proof'
import { replaceConversationInSnapshot } from './structured-conversation-tab-replacement'

/** The snapshot the host stores for a worktree; versions are total-order stamps over `existing`. */
export function stampStoredMobileSessionSnapshot(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  existing: RuntimeMobileSessionTabsSnapshot | undefined
): RuntimeMobileSessionTabsSnapshot {
  for (const replacement of getStructuredAgentSessionHost()?.conversationReplacements?.() ?? []) {
    snapshot = replaceConversationInSnapshot(snapshot, replacement)
  }
  snapshot = preserveTerminalRetirementProofs(snapshot, existing)
  const snapshotVersion = existing
    ? Math.max(snapshot.snapshotVersion, existing.snapshotVersion + 1)
    : snapshot.snapshotVersion
  return snapshotVersion === snapshot.snapshotVersion ? snapshot : { ...snapshot, snapshotVersion }
}
