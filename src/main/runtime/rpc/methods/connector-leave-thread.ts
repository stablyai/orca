// `orca bot reply --leave-thread`: the calling bot stops being woken in the Slack thread its chat
// answers, until someone @mentions it. Orca decides which bot, which thread and whether this turn
// may, from its own records; the agent names nothing. The thread is then owed Orca's own
// confirmation, saved with the mute, which the turn's end posts.
import type { ConnectorConversation } from '../../../../shared/connectors/connector-cloud-contract'
import { ConnectorLeaveThread } from '../../../../shared/rpc-contract/connectors/connector-params'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { requireStructuredHost } from '../../../bots/bot-chat-session'
import { leaveThreadRefusal } from '../../../bots/bot-leave-thread-authority'
import { REPLY_ONLY_REFUSAL, LOOK_AROUND_REFUSAL } from '../../../bots/bot-look-around-policy'
import { slackThreadBotUser } from '../../../connector-cloud/connector-thread-mute'
import {
  reserveThreadMuteSave,
  threadMuteSaves
} from '../../../connector-cloud/connector-thread-mute-saves'
import { chatPaneKey } from '../../../external-conversations/external-conversation-chat'
import { readThreadMute } from '../../../external-conversations/external-conversation-link-writes'
import { defineMethod } from '../core'
import { ConnectorActError } from './connector-act'
import { CONNECTOR_CLOUD_MENTIONED_FEATURE } from '../../../../shared/connector-cloud-features'
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
    // Only an @mention brings it back: never leave where the cloud can't say there was one.
    if (!runtime.getConnectorCloud()?.cloudFeatures()?.has(CONNECTOR_CLOUD_MENTIONED_FEATURE)) {
      throw new ConnectorActError('leave_unavailable', LEAVE_THREAD_REFUSALS.leave_unavailable)
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
    // Left in this turn and no @mention since: nothing to save, and its line is already owed.
    if (thread.muted && thread.leaveLine === turnId) {
      return { ok: true as const, already: true as const }
    }
    // Replies arriving from now on wait for this leave to save or be refused, so none slips past it
    // while its turn is read or it waits in the thread's queue.
    const release = reserveThreadMuteSave(key)
    try {
      await leaveFrom(runtime, sessionId, key, turnId, seam, store)
    } finally {
      release()
    }
    // The turn's end posts the line, after its answer; the link keeps it owed until then.
    return { ok: true as const }
  }
})

async function leaveFrom(
  runtime: Parameters<typeof CONNECTOR_LEAVE_THREAD_METHOD.handler>[1]['runtime'],
  sessionId: string,
  key: ConnectorConversation,
  turnId: number,
  seam: { queued: (key: ConnectorConversation, work: () => Promise<unknown>) => Promise<unknown> },
  store: Parameters<typeof threadMuteSaves>[0]
): Promise<void> {
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
    save.saving = threadMuteSaves(store)(key, true, turnId)
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
}
