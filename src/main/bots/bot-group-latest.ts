// A room's newest post, for its sidebar row, when a member finishes a reply; the owner's send stamps its own.
import {
  botGroupCompletedReply,
  botGroupTurnItems,
  botGroupTurnOperation,
  isBotGroupMemberSession
} from '../../shared/bots/bot-group'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { requireStructuredHost } from './bot-chat-session'
import { runtimeBotGroups } from './bot-group-runtime'

/** A member's turn ended: if it finished with a reply, that reply is the room's newest post,
 *  unless a post saved after the turn ended is newer. */
export async function noteBotGroupMemberReply(
  runtime: OrcaRuntimeService,
  sessionId: string
): Promise<void> {
  const groups = isBotGroupMemberSession(sessionId) ? runtimeBotGroups(runtime) : null
  const owner = groups?.store.memberOf(sessionId)
  if (!groups || !owner) {
    return
  }
  // Taken before the await: the reply follows every post already stored and precedes any later one,
  // and follows any reply whose turn ended earlier.
  const after = groups.store.messages(owner.group.id, 1)[0]?.sequence ?? 0
  const reply = groups.store.reserveReplyOrder()
  const endedAt = Date.now()
  const host = await requireStructuredHost(runtime)
  // The latest ended turn and the rows that place it; its reply rows follow it.
  const { snapshot } = await (
    await host.journalReads(sessionId)
  ).operationWindow({ latestEndedTurn: true })
  // The turn that just ended is the session's latest to end; a queued one behind it is still open.
  let ended: { itemId: string; completedAt: number; completed: boolean } | null = null
  for (const item of snapshot.items) {
    if (item.body.kind === 'turn' && item.body.state !== 'running') {
      const completedAt = item.body.completedAt ?? 0
      if (!ended || completedAt >= ended.completedAt) {
        ended = { itemId: item.itemId, completedAt, completed: item.body.state === 'completed' }
      }
    }
  }
  const operationId = ended ? botGroupTurnOperation(snapshot, ended.itemId) : null
  // Found by its operation, however far back in the room its post is.
  const message = operationId ? groups.store.operationMessage(operationId) : null
  const turn = message?.turns.find((candidate) => candidate.operationId === operationId)
  if (!operationId || !message || !turn || message.groupId !== owner.group.id) {
    return
  }
  const finished = ended?.completed
    ? botGroupCompletedReply(botGroupTurnItems(snapshot, operationId, turn.workerDispatchIds))
    : null
  // Saved now, while the chat is open, so later posts never reopen it to quote this reply.
  groups.store.update({
    ...message,
    turns: message.turns.map((candidate) =>
      candidate === turn ? { ...candidate, reply: finished?.text ?? null } : candidate
    )
  })
  if (!finished) {
    return
  }
  const kept = groups.store.setLatest(
    owner.group.id,
    { authorName: turn.botName, text: finished.text, at: finished.completedAt ?? endedAt },
    { after, reply }
  )
  if (kept) {
    groups.changed()
  }
}
