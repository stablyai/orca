// `orca bot reply --leave-thread`: the calling bot stops being woken in the Slack thread its chat
// answers, until someone @mentions it. Orca decides which bot, which thread and whether this turn
// may, from its own records; the agent names nothing. The thread is then owed Orca's own
// confirmation, saved with the mute, which the turn's end posts.
import type { ConnectorConversation } from '../../../../shared/connectors/connector-cloud-contract'
import { ConnectorLeaveThread } from '../../../../shared/rpc-contract/connectors/connector-params'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { sameSession } from '../../../bots/bot-turn-for'
import { sessionCallerOf } from '../../orchestration/addressing/orchestration-caller-identity'
import { requireStructuredHost } from '../../../bots/bot-chat-session'
import { leaveThreadRefusal } from '../../../bots/bot-leave-thread-authority'
import { REPLY_ONLY_REFUSAL, LOOK_AROUND_REFUSAL } from '../../../bots/bot-look-around-policy'
import { slackThreadBotUser } from '../../../connector-cloud/connector-thread-mute'
import {
  reserveThreadMuteSave,
  ThreadMuteUnconfirmedError,
  threadMuteSaving,
  threadMuteSaves
} from '../../../connector-cloud/connector-thread-mute-saves'
import { chatPaneKey } from '../../../external-conversations/external-conversation-chat'
import { readThreadMute } from '../../../external-conversations/external-conversation-link-writes'
import { defineMethod } from '../core'
import { ConnectorActError } from './connector-act'
import { CONNECTOR_CLOUD_MENTIONED_FEATURE } from '../../../../shared/connector-cloud-features'
import {
  LEAVE_THREAD_REFUSALS,
  LEAVE_THREAD_UNCONFIRMED
} from '../../../../shared/connectors/connector-leave-thread-copy'

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
    // Only the chat itself, as Orca verified the caller: never one chat leaving for another.
    const caller = sessionCallerOf(context.orchestrationCaller)?.sessionId
    if (!bot || caller === undefined || !sameSession(caller, sessionId)) {
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
    // Left in this turn and no @mention since: nothing to save, and its line is already owed. A
    // leave still saving answers only once it is on disk, as what it saved.
    if (thread.muted && thread.leaveLine === turnId) {
      await threadMuteSaving(key)?.catch(() => undefined)
      const saved = readThreadMute(store, key)
      if (
        typeof saved !== 'object' ||
        saved === null ||
        !saved.muted ||
        saved.leaveLine !== turnId
      ) {
        throw new ConnectorActError('thread_mute_not_saved', NOT_SAVED)
      }
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

function leaveFrom(
  runtime: Parameters<typeof CONNECTOR_LEAVE_THREAD_METHOD.handler>[1]['runtime'],
  sessionId: string,
  key: ConnectorConversation,
  turnId: number,
  seam: {
    queued: (
      key: ConnectorConversation,
      work: () => Promise<unknown>
    ) => Promise<{ outcome: string } | undefined>
  },
  store: Parameters<typeof threadMuteSaves>[0]
): Promise<void> {
  // Only the turn running now: a report that woke it never borrows the request before it.
  const checking = (async () => {
    const host = await requireStructuredHost(runtime)
    const { snapshot } = await (
      await host.journalReads(sessionId)
    ).operationWindow({ latestTurns: 2, turnShape: true })
    return leaveThreadRefusal(snapshot.items, snapshot.submissions, key)
  })()
  // Read below once its place comes; a read that fails first is never an unhandled rejection.
  checking.catch(() => undefined)
  // Its place in the thread's queue is taken now, before the read, so a reply that waits on this
  // leave is always behind it and never holds it up. The save is on disk before this answers.
  const save: { saving?: Promise<void>; ran?: Promise<void>; stopped?: true } = {}
  const queued = seam.queued(key, () => {
    save.ran = (async () => {
      // A Stop since its place came: it never saves after the thread was stopped.
      if ((await checking.catch(() => 'unread')) === null && !save.stopped) {
        save.saving = threadMuteSaves(store)(key, true, turnId)
        await save.saving.catch(() => undefined)
      }
    })()
    return save.ran
  })
  return (async () => {
    if ((await queued)?.outcome === 'refused') {
      save.stopped = true
    }
    // A Stop answers the queue at once while its work may still run: what it did is the answer.
    await save.ran
    const refusal = await checking
    if (refusal) {
      throw new ConnectorActError(refusal, refusal === 'leave_refused_mixed' ? MIXED : STALE)
    }
    try {
      // A Stop settled the queue before the save ran: nothing was written.
      if (!save.saving) {
        throw new Error('thread queue stopped before the save')
      }
      await save.saving
    } catch (error) {
      console.warn('[connectors] could not save that a bot left its thread', error)
      if (error instanceof ThreadMuteUnconfirmedError) {
        throw new ConnectorActError('leave_unconfirmed', LEAVE_THREAD_UNCONFIRMED)
      }
      throw new ConnectorActError('thread_mute_not_saved', NOT_SAVED)
    }
  })()
}
