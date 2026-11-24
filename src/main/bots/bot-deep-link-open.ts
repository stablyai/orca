import type { BotDeepLink, BotDeepLinkOutcome } from '../../shared/bot-deep-link'
import {
  findLink,
  type ExternalConversationLinkStore
} from '../external-conversations/external-conversation-links'

/**
 * A bare link opens the bot's Home and a conversation its chat's tab, both in the renderer. A
 * thread this computer doesn't have goes to the renderer too: the bot may be a paired server's.
 */
export async function openBotDeepLink(
  store: ExternalConversationLinkStore,
  link: BotDeepLink,
  workers?: (
    sessionId: string
  ) => Promise<readonly { host: string; chatSessionId: string | null; worktreeId: string | null }[]>
): Promise<BotDeepLinkOutcome> {
  if (!link.conversation) {
    return { kind: 'home', botId: link.botId }
  }
  const linked = findLink(store, link.conversation)
  if (
    !linked ||
    (link.sessionId && !linked.link.bot) ||
    (linked.link.bot && linked.link.bot.botId !== link.botId)
  ) {
    return { kind: 'home', botId: link.botId, conversation: link.conversation }
  }
  let workspaceId = linked.workspace.worktreeId
  let sessionId = linked.link.sessionId
  if (link.sessionId && link.sessionId !== sessionId && linked.link.bot && workers) {
    const rows = await workers(sessionId).catch(() => [])
    const worker = rows.find(
      (row) => row.host === 'local' && row.chatSessionId === link.sessionId && row.worktreeId
    )
    if (worker?.worktreeId) {
      workspaceId = worker.worktreeId
      sessionId = link.sessionId
    }
  }
  return {
    kind: 'chat',
    workspaceId,
    sessionId,
    ...(link.itemId && link.sessionId === sessionId ? { itemId: link.itemId } : {})
  }
}
