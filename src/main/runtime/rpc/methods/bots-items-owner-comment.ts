import type { z } from 'zod'
import { AGENT_SESSION_ATTACHMENTS_DIR_NAME } from '../../../../shared/agent-session/agent-session-attachments'
import { botItemEventId, parseBotItemEventId } from '../../../../shared/bots/bot-items'
import { BotItemsOwnerComment } from '../../../../shared/rpc-contract/bots-items-params'
import { admitBotItemCommentAttachments } from '../../../bots/bot-item-comment-attachments'
import type { BotItemOwnerActor } from '../../../bots/bot-items-input'
import type { BotItemsRemote } from '../../../bots/bot-items-ops'
import type { BotItemRecord } from '../../../bots/bot-items-schema'
import { botMailSession } from '../../../bots/bot-mail-chat'
import {
  getAgentSessionAttachmentClaimer,
  getAgentSessionAttachmentStore
} from '../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { defineMethod, type RpcContext } from '../core'
import { botItemOwnerActor } from './bots-caller-gates'
import { resolveItem } from './bots-items-write-support'

export const BOT_ITEM_OWNER_COMMENT_METHOD = defineMethod({
  name: 'bots.items.owner.comment',
  permission: 'workspace',
  params: BotItemsOwnerComment,
  handler: async (params, context) => {
    const actor = botItemOwnerActor(context)
    const { botItems } = context.runtime
    const store = botItems.store()
    const item = await resolveItem(store, params.item)
    const eventId = await postOwnerComment(store, item, params, context, actor)
    botItems.changed([item])
    // The comment is stored and its mail owed: the reply never waits on the chat taking it.
    void botItems
      .sendOwedMail()
      .catch((error: unknown) => console.warn('[bots] items: mailing a comment failed', error))
    return { eventId: eventId === null ? null : botItemEventId(eventId) }
  }
})

async function postOwnerComment(
  store: BotItemsRemote,
  item: BotItemRecord,
  params: z.output<typeof BotItemsOwnerComment>,
  { runtime, caller }: RpcContext,
  actor: BotItemOwnerActor
): Promise<number | null> {
  const hasAttachments =
    params.images?.length || params.text.includes(AGENT_SESSION_ATTACHMENTS_DIR_NAME)
  const requestId = params.requestId
  const posted = () => (requestId ? store.ownerCommentByRequest(item.uid, requestId) : null)
  // A reply may have committed before the response was lost. Its uploads need not still exist.
  const replay = hasAttachments ? await posted() : null
  if (replay !== null) {
    return replay
  }
  if (hasAttachments) {
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  }
  const attached = await admitBotItemCommentAttachments(
    {
      store: getAgentSessionAttachmentStore(),
      local: caller?.kind === 'desktop',
      claim: getAgentSessionAttachmentClaimer(),
      chat: async () => {
        const bot = runtime.bots.list().find((entry) => entry.id === item.ownerBotId)
        return bot
          ? { sessionId: await botMailSession(runtime, bot, item.chatId), title: null }
          : null
      }
    },
    params.text,
    params.images ?? []
  ).catch(async (error: unknown) => {
    // A concurrent retry can have committed while admission was in flight.
    const prior = await posted()
    if (prior === null) {
      throw error
    }
    return prior
  })
  if (typeof attached === 'number') {
    return attached
  }
  const outcome = await store.ownerComment(
    item.uid,
    attached.text,
    actor,
    attached.images,
    undefined,
    requestId,
    params.questionId === undefined ? undefined : (parseBotItemEventId(params.questionId) ?? -1),
    params.plain === true,
    params.skills,
    params.skipped
  )
  return outcome.eventId
}
