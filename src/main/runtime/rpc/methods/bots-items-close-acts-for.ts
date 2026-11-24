// Whom a bot's closing chat acts for, kept on the close so the journal says whose work it was.
import type { BotRequestAsker } from '../../../../shared/bots/bot-acts-for'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { RpcContext } from '../core'
import type { BotItemWriter } from './bots-items-caller'
import { readFirstMessageActsFor } from './orchestration/messaging/bot-first-message-acts-for'

/** Whom the writer's chat acts for, kept on a close so the journal says whose work it was: its
 *  record, else its /clear root's first message when that conversation is already open (never
 *  opening one); unknown, never the owner, when neither says. Only who, not where they asked. */
export async function closingChatActsFor(
  context: { runtime: Pick<RpcContext['runtime'], 'getOrchestrationDb'> },
  writer: { actor: Pick<BotItemWriter['actor'], 'chatId'> }
): Promise<BotRequestAsker[]> {
  try {
    const db = context.runtime.getOrchestrationDb()
    const root = writer.actor.chatId
    const recorded = db.getBotConversationActsFor(root)?.actsFor
    const host = getStructuredAgentSessionHost()
    // Started in the same tick as the check, so it takes the open handle and can't reopen one.
    const reads = !recorded && host?.hasSession(root) ? host.journalReads(root) : null
    const askers = recorded ?? (reads ? await readFirstMessageActsFor(db, reads, null) : null)
    return (askers ?? [{ kind: 'unknown' }]).map((asker): BotRequestAsker =>
      asker.kind === 'person'
        ? {
            kind: 'person',
            source: asker.source,
            userId: asker.userId,
            ...(asker.name ? { name: asker.name } : {}),
            workspaceId: null,
            role: asker.role
          }
        : asker
    )
  } catch (error) {
    console.warn('[bots] could not read whom a closing chat acts for', error)
    return [{ kind: 'unknown' }]
  }
}
