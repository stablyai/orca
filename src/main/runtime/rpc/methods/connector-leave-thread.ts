// `orca bot reply --leave-thread`: the calling bot stops being woken in the Slack thread its chat
// answers, until someone @mentions it. Orca decides which bot, which thread and whether this turn
// may, from its own records; the agent names nothing. Orca posts the confirmation itself.
import { createHash } from 'node:crypto'
import { ConnectorLeaveThread } from '../../../../shared/rpc-contract/connectors/connector-params'
import { cloudConversation } from '../../../../shared/connectors/connector-cloud-contract'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { requireStructuredHost } from '../../../bots/bot-chat-session'
import { leaveThreadRefusal } from '../../../bots/bot-leave-thread-authority'
import { REPLY_ONLY_REFUSAL, LOOK_AROUND_REFUSAL } from '../../../bots/bot-look-around-policy'
import { botTurnFor } from '../../../bots/bot-turn-for'
import { slackThreadBotUser } from '../../../connector-cloud/connector-thread-mute'
import { threadMuteSaves } from '../../../connector-cloud/connector-thread-mute-saves'
import { chatPaneKey } from '../../../external-conversations/external-conversation-chat'
import { readThreadMute } from '../../../external-conversations/external-conversation-link-writes'
import {
  leftInTurn,
  noteThreadLeft,
  THREAD_LEFT_LINE
} from '../../../external-conversations/external-conversation-thread-leaves'
import { sessionCallerOf } from '../../orchestration/addressing/orchestration-caller-identity'
import { defineMethod } from '../core'
import { ConnectorActError } from './connector-act'
import { LEAVE_THREAD_REFUSALS } from '../../../../shared/connectors/connector-leave-thread-copy'

const {
  not_a_thread: NOT_A_THREAD,
  leave_refused_stale: STALE,
  leave_refused_mixed: MIXED
} = LEAVE_THREAD_REFUSALS
const NOT_SAVED = LEAVE_THREAD_REFUSALS.thread_mute_not_saved

export const CONNECTOR_LEAVE_THREAD_METHOD = defineMethod({
  name: 'connector.leaveThread',
  permission: 'workspace',
  params: ConnectorLeaveThread,
  handler: async ({ sessionId }, context) => {
    const { runtime } = context
    const bot = runtime.bots.enabled() ? botOfSession(runtime.bots, sessionId) : null
    if (!bot) {
      throw new ConnectorActError(
        'not_a_bot_session',
        "This isn't a bot's chat: only a bot can leave a Slack thread it follows."
      )
    }
    if (runtime.lookAround.botOfTidyUp(sessionId)) {
      throw new ConnectorActError('look_around_reads_only', REPLY_ONLY_REFUSAL)
    }
    if (runtime.lookAround.botOfLook(sessionId)) {
      throw new ConnectorActError('look_around_reads_only', LOOK_AROUND_REFUSAL)
    }
    const seam = runtime.getExternalConversationSeam()
    const target = seam?.replyTarget(chatPaneKey(sessionId)) ?? null
    const key = target?.key
    if (!seam || !key || key.source !== 'slack' || !slackThreadBotUser(key.externalId)) {
      throw new ConnectorActError('not_a_thread', NOT_A_THREAD)
    }
    const store = runtime.requireStore()
    const thread = readThreadMute(store, key)
    if (!thread || thread === 'not_bot' || thread.botId !== bot.id) {
      throw new ConnectorActError('not_a_thread', NOT_A_THREAD)
    }
    const turnId = target.turnId
    if (turnId === null) {
      throw new ConnectorActError('leave_refused_stale', STALE)
    }
    if (leftInTurn(sessionId, turnId)) {
      return { ok: true as const, already: true as const }
    }
    // Only the turn running now: a report that woke it never borrows the request before it.
    const host = await requireStructuredHost(runtime)
    const { snapshot } = await (
      await host.journalReads(sessionId)
    ).operationWindow({ latestTurns: 2, turnShape: true })
    const refusal = leaveThreadRefusal(snapshot.items, snapshot.submissions, key)
    if (refusal) {
      throw new ConnectorActError(refusal, refusal === 'leave_refused_mixed' ? MIXED : STALE)
    }
    // In the thread's queue, ordered with its deliveries; the save is on disk before this answers.
    const save: { saving?: Promise<void> } = {}
    await seam.queued(key, async () => {
      save.saving = threadMuteSaves(store)(key, true)
      await save.saving.catch(() => undefined)
    })
    try {
      // A Stop settled the queue before the save ran: nothing was written.
      if (!save.saving) {
        throw new Error('thread queue stopped before the save')
      }
      await save.saving
    } catch (error) {
      console.warn('[connectors] could not save that a bot left its thread', error)
      throw new ConnectorActError('thread_mute_not_saved', NOT_SAVED)
    }
    const conversation = cloudConversation(key)
    const turnFor = await botTurnFor(
      runtime,
      sessionId,
      sessionCallerOf(context.orchestrationCaller)?.sessionId
    )
    noteThreadLeft(sessionId, {
      turnId,
      stillLeft: () => {
        const now = readThreadMute(store, key)
        return typeof now === 'object' && now !== null && now.muted
      },
      // Once per turn, however often retried: its reply id is the turn's.
      post: async () => {
        const replyId = `leave-${createHash('sha256').update(`${sessionId}:${turnId}`).digest('base64url')}`
        const sent =
          conversation &&
          (await runtime
            .getConnectorCloud()
            ?.reply({ replyId, conversation, turnId, text: THREAD_LEFT_LINE, turnFor }))
        if (!sent || !sent.ok) {
          console.warn('[connectors] could not post that a bot left its thread')
        }
      }
    })
    return { ok: true as const }
  }
})
