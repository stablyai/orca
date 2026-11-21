// Orca's own item mail to a member's room session: its owner answered or commented on an item of the
// member's. Like a worker's report, it continues the member's latest request in that room.
import type { BotGroupMember, BotGroupPeerScope } from '../../shared/bots/bot-group-schema'
import type { BotGroupRuntime } from './bot-group-runtime'

/** The request item mail continues; null when the member took no turn in the room. */
export function itemMailRoot(
  groups: BotGroupRuntime,
  groupId: string,
  member: BotGroupMember
): BotGroupPeerScope | null {
  // Newest first on the room's (group_id, sequence) index; a member's latest turn is near the end.
  const row = groups.runtime
    .getOrchestrationDb()
    .db.prepare(
      `SELECT id FROM bot_group_messages WHERE group_id = ?
         AND EXISTS (SELECT 1 FROM json_each(record, '$.turns')
           WHERE json_extract(value, '$.sessionId') = ?)
         ORDER BY sequence DESC LIMIT 1`
    )
    .get(groupId, member.sessionId)
  const latest = row ? groups.store.message(String(row.id)) : null
  return latest
    ? {
        id: groupId,
        rootRequestId: latest.rootRequestId ?? latest.id,
        rootSequence: latest.rootSequence ?? latest.sequence,
        sourceSessionId: member.sessionId,
        targetSessionId: member.sessionId
      }
    : null
}
