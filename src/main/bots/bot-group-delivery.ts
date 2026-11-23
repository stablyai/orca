import { BotFailureError } from '../../shared/bots/bot-failure-copy'
import type { z } from 'zod'
import {
  isBotGroupMemberSession,
  type BotGroupMessage,
  type BotGroupSend,
  type BotGroupTurn
} from '../../shared/bots/bot-group'
import { botGroupAudience } from '../../shared/bots/bot-group-mentions'
import { stripSentImagePromptMarkers } from '../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import { sendAgentTurn } from '../runtime/orchestration/turn-delivery/send-agent-turn'
import { agentSessionSendBodyFingerprint } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  getAgentSessionAttachmentClaimer,
  getAgentSessionAttachmentStore
} from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { hasAttachmentStoreReference } from './bot-attachment-images'
import { admitBotGroupMessageAttachments, botGroupMessageSummary } from './bot-group-attachments'
import { requireStructuredHost, type BotRunFields } from './bot-chat-session'
import { requireGroupBots } from './bot-group-membership'
import type { BotGroupRuntime } from './bot-group-runtime'
import { settleDeadGroupMailTurns } from './bot-group-dead-mail-turns'
import { reserveGroupTurns } from './bot-group-turn-reservation'
import { botGroupTurnBody } from './bot-group-turn-body'
import { deliverRemoteAsks } from './bot-group-remote'
import { collectRemoteAnswers, presentPageAnswers } from './bot-group-remote-answers'
import { remoteAsksFor } from './bot-group-remote-question'

export type SendBotGroupMessageOptions = {
  /** This host's own window sent: local dropped images are copied into the store. */
  local?: boolean
}

export async function sendBotGroupMessage(
  groups: BotGroupRuntime,
  input: z.infer<typeof BotGroupSend>,
  options: SendBotGroupMessageOptions = {}
): Promise<BotGroupMessage> {
  // The remote questions of a post stored by this call; a replayed send dispatches none.
  let remoteBodies: Map<string, string> | null = null
  const message = await runKeyedSerializedOperation(groups.queues, input.groupId, async () => {
    const existing = groups.store.message(input.messageId)
    if (existing) {
      if (
        existing.groupId !== input.groupId ||
        existing.threadId !== input.threadId ||
        existing.text !== input.text ||
        (existing.images?.length ?? 0) !== (input.images?.length ?? 0)
      ) {
        throw new BotFailureError('groupMessageIdReused')
      }
      return existing
    }
    const group = groups.store.room(input.groupId, input.threadId)
    if (group.revision !== input.revision) {
      throw new BotFailureError('groupChangedBeforeSend')
    }
    if (group.members.length === 0) {
      throw new BotFailureError('groupEmptyBeforeSend')
    }
    const bots = requireGroupBots(
      groups,
      group.members.map((member) => member.botId)
    )
    const requestedImages = input.images ?? []
    const audience = botGroupAudience(
      stripSentImagePromptMarkers(input.text, requestedImages.length),
      group,
      bots
    )
    if (requestedImages.length > 0 || hasAttachmentStoreReference(input.text)) {
      await groups.runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
    }
    const images = await admitBotGroupMessageAttachments(
      {
        store: getAgentSessionAttachmentStore(),
        local: options.local === true,
        claim: getAgentSessionAttachmentClaimer(),
        memberSessionIds: group.members.map((member) => member.sessionId)
      },
      input.text,
      requestedImages
    )
    const { turns, contexts, history, completed } = await reserveGroupTurns(
      groups,
      group,
      input.threadId,
      bots,
      audience
    )
    const remote = remoteAsksFor(
      group,
      audience,
      history,
      completed,
      { id: input.messageId, text: input.text, images },
      groups.store.get(group.id).name
    )
    const stored = groups.store.append(
      {
        id: input.messageId,
        groupId: group.id,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        author: { kind: 'owner' },
        text: input.text,
        ...(images.length > 0 ? { images } : {}),
        createdAt: Date.now(),
        turns,
        ...(remote ? { remoteAsks: remote.asks } : {})
      },
      contexts
    )
    groups.store.setLatest(
      group.id,
      { authorName: null, text: botGroupMessageSummary(stored), at: stored.createdAt },
      { post: stored.sequence }
    )
    if (input.threadId) {
      titleThread(groups, input.threadId, stored)
    }
    remoteBodies = remote?.bodies ?? null
    return stored
  })
  // Marks its asks in flight before any reader can see the post.
  void deliverRemoteAsks(groups, message, remoteBodies)
  groups.changed(message.groupId)
  for (const turn of message.turns) {
    void deliverTurn(groups, message, turn)
  }
  return message
}

/** A thread is named by its first post, cut to one line. */
function titleThread(groups: BotGroupRuntime, threadId: string, message: BotGroupMessage): void {
  const group = groups.store.get(message.groupId)
  if (group.threads?.find((thread) => thread.id === threadId)?.title) {
    return
  }
  const title = botGroupMessageSummary(message).slice(0, 80)
  const titled = {
    ...group,
    threads: group.threads?.map((thread) =>
      thread.id === threadId ? { ...thread, title } : thread
    )
  }
  groups.store.put(titled)
  groups.named(titled)
}

export function assertGroupQueuedMessageAllowed(
  groups: BotGroupRuntime,
  sessionId: string,
  operationId: string
): void {
  if (!isBotGroupMemberSession(sessionId)) {
    return
  }
  const message = groups.store.operationMessage(operationId)
  const turn = message?.turns.find(
    (turn) => turn.operationId === operationId && turn.sessionId === sessionId
  )
  if (!message || !turn) {
    throw new BotFailureError('groupRequestUnverifiable')
  }
  try {
    assertTurnActive(groups, message, turn)
  } catch (error) {
    recordTurnError(groups, message.id, operationId, error)
    groups.changed(message.groupId)
    throw error
  }
}

function assertTurnActive(
  groups: BotGroupRuntime,
  message: BotGroupMessage,
  turn: BotGroupTurn
): void {
  const group = groups.store.room(message.groupId, message.threadId)
  if (
    !group.members.some(
      (member) =>
        member.sessionId === turn.sessionId &&
        (member.stoppedThroughSequence ?? 0) < (message.rootSequence ?? message.sequence)
    )
  ) {
    throw new BotFailureError('groupTurnInactive')
  }
  const bot = groups.runtime.bots.list().find((bot) => bot.id === turn.botId)
  if (!bot || bot.paused || !groups.runtime.bots.enabled()) {
    throw new BotFailureError('groupBotUnavailable')
  }
}

function recordTurnError(
  groups: BotGroupRuntime,
  messageId: string,
  operationId: string,
  error: unknown
): void {
  const current = groups.store.message(messageId)
  if (current) {
    groups.store.update({
      ...current,
      turns: current.turns.map((item) =>
        item.operationId === operationId
          ? {
              ...item,
              error: error instanceof Error ? error.message : String(error),
              ...(error instanceof BotFailureError ? { failure: error.data.botFailure } : {})
            }
          : item
      )
    })
  }
}

/** Resolves to the sent body's fingerprint once the member's session took the turn. `run`: the
 *  automation run this post is, sent as that run like a run in any other chat. */
export async function deliverTurn(
  groups: BotGroupRuntime,
  message: BotGroupMessage,
  turn: BotGroupTurn,
  run?: BotRunFields
): Promise<string | undefined> {
  const context = groups.store.pendingContext(turn.operationId)
  if (context === null || groups.deliveries.has(turn.operationId)) {
    return undefined
  }
  groups.deliveries.add(turn.operationId)
  try {
    const host = await requireStructuredHost(groups.runtime)
    if (await (await host.journalReads(turn.sessionId)).operationSent(turn.operationId)) {
      return undefined
    }
    const beforeRun = () => assertTurnActive(groups, message, turn)
    beforeRun()
    // A hand-off serves the person's post it continues, whose words and images it carries.
    const original =
      (message.mentioned && message.rootRequestId
        ? groups.store.message(message.rootRequestId)
        : null) ?? message
    const body = botGroupTurnBody({
      message,
      original,
      botName: turn.botName,
      roomName: groups.store.get(message.groupId).name,
      context,
      run
    })
    const outcome = await sendAgentTurn({
      kind: 'structured-session',
      host,
      sessionId: turn.sessionId,
      callerKey: `bot-group:${message.threadId ?? message.groupId}:${turn.botId}`,
      turn: {
        body,
        operationId: turn.operationId,
        expectedRuntimeFence: host.deps.store.requireWritableRecord(turn.sessionId).lease
          .runtimeFence,
        delivery: 'queue',
        personsMessage: true,
        beforeRun
      }
    })
    if (outcome.kind === 'refused') {
      throw new Error(outcome.refusal.message)
    }
    return agentSessionSendBodyFingerprint(turn.sessionId, body)
  } catch (error) {
    recordTurnError(groups, message.id, turn.operationId, error)
    return undefined
  } finally {
    groups.store.delivered([turn.operationId])
    groups.deliveries.delete(turn.operationId)
    groups.changed(message.groupId)
  }
}

/** At startup: a crash between reservation and native admission replays the same operation,
 *  never a fresh turn. */
export function resumePendingGroupDeliveries(groups: BotGroupRuntime): void {
  if (!groups.runtime.bots.enabled()) {
    return
  }
  for (const { message, turn } of groups.store.pending()) {
    void deliverTurn(groups, message, turn)
  }
}

/** One room's latest page; its `group` carries that room's member sessions. */
export function readBotGroup(
  groups: BotGroupRuntime,
  groupId: string,
  beforeSequence?: number,
  threadId?: string
) {
  const group = groups.store.room(groupId, threadId)
  const messages = collectRemoteAnswers(
    groups,
    groups.store.roomMessages(groupId, threadId, 40, beforeSequence)
  )
  settleDeadGroupMailTurns(groups, messages)
  return {
    group,
    // An ended turn draws from its saved reply and end, so the room needs none of its chat's rows.
    messages: presentPageAnswers(messages),
    hasEarlier:
      messages.length > 0 &&
      groups.store.roomMessages(groupId, threadId, 1, messages[0].sequence).length > 0
  }
}
