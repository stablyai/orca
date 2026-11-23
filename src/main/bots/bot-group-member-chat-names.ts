// A member's chat lives in its bot's home, so the bot's chat list, its row line, its items' Chat
// field and "Replying in" all name it by its record: the room's name, not the room's prompt.
import { botGroupRoom, type BotGroup } from '../../shared/bots/bot-group'
import { normalizeAgentSessionConversationName } from '../../shared/agent-session/conversation-naming/agent-session-conversation-name'
import { requireStructuredHost } from './bot-chat-session'
import type { BotGroupRuntime } from './bot-group-runtime'

/** A room's name as people see it: a thread's title, else the group's name. */
export function botGroupRoomTitle(group: BotGroup, threadId: string | undefined): string {
  const thread = threadId ? group.threads?.find((entry) => entry.id === threadId) : undefined
  return thread?.title ?? group.name
}

/** Names every member chat of `groups` (all rooms when omitted) after its room. A changed room
 *  renames its chats; `kept` leaves a chat someone renamed alone, for the pass that names chats
 *  made before this rule. Naming is metadata: a chat that cannot be renamed blocks nothing. */
export async function nameBotGroupMemberChats(
  botGroups: BotGroupRuntime,
  groups: readonly BotGroup[] = botGroups.store.list(),
  { kept = false }: { kept?: boolean } = {}
): Promise<void> {
  // No rooms, nothing to name: the chat host is not opened for it.
  if (groups.length === 0) {
    return
  }
  const host = await requireStructuredHost(botGroups.runtime)
  if (host.deps.store.readOnly) {
    return
  }
  for (const group of groups) {
    for (const threadId of [undefined, ...(group.threads ?? []).map((thread) => thread.id)]) {
      const title = botGroupRoomTitle(group, threadId)
      const name = normalizeAgentSessionConversationName(title)
      for (const { sessionId } of botGroupRoom(group, threadId).members) {
        const record = host.deps.store.getConversation(sessionId)
        const named = record?.conversationNameSource === 'user'
        if (!name || !record || (named && (kept || record.conversationName === name))) {
          continue
        }
        await host
          .setUserConversationName(sessionId, title, 'rename')
          .catch((error: unknown) =>
            console.warn('[bot-groups] naming a member chat failed', error)
          )
      }
    }
  }
}
