import type { BotGroupMessage } from '../../shared/bots/bot-group'
import type { MessageRow } from '../runtime/orchestration/db/orchestration-records'
import { botGroupRoomMailAddress } from '../../shared/bots/bot-group-room-mail'
import type { BotGroupRuntime } from './bot-group-runtime'
import { isRemoteAskInFlight } from './bot-group-remote'

// How remote members' answers, which come back by mail, reach their posts and the room's readers.

/** A remote answer kept on its post; the whole answer stays in this computer's mail. */
const SAVED_ANSWER_MAX = 64_000
/** A room page's remote answer text, so a page of long answers stays far under the reply limit. */
const PAGE_ANSWER_BUDGET = 1_000_000
const PAGE_ANSWER_MAX = 16_000

/** Asks as a reader sees them: a `sending` ask whose handover is no longer running may or may not
 *  have reached its computer; its answer still lands if one comes. Long answers are shortened to
 *  the page's budget, newest posts first, so a page stays readable. */
export function presentRemoteAsks(messages: readonly BotGroupMessage[]): BotGroupMessage[] {
  let budget = PAGE_ANSWER_BUDGET
  const shown = new Map<string, BotGroupMessage>()
  for (const message of messages.toReversed()) {
    if (!message.remoteAsks?.length) {
      shown.set(message.id, message)
      continue
    }
    shown.set(message.id, {
      ...message,
      remoteAsks: message.remoteAsks.map((ask) => {
        const state =
          ask.state === 'sending' && !isRemoteAskInFlight(ask.requestId)
            ? ('unknown' as const)
            : ask.state
        if (ask.reply?.kind !== 'answer') {
          return { ...ask, state }
        }
        const answer = ask.reply.text.slice(0, Math.max(0, Math.min(PAGE_ANSWER_MAX, budget)))
        budget -= answer.length
        return {
          ...ask,
          state,
          reply: {
            kind: 'answer' as const,
            text: answer,
            ...(answer.length < ask.reply.text.length || ask.reply.truncated
              ? { truncated: true as const }
              : {})
          }
        }
      })
    })
  }
  return messages.map((message) => shown.get(message.id) ?? message)
}

/**
 * Copies answers that came back by mail onto their posts. Only mail the relay brought home on this
 * room's own conversation with that computer counts; the other computer threads its answer and its
 * "won't answer" notice on the question's id, and the answer carries the bot's answer marker. An
 * answer replaces a notice, never the reverse. Each post is merged as it is stored now.
 */
export function collectRemoteAnswers(
  groups: BotGroupRuntime,
  messages: readonly BotGroupMessage[]
): BotGroupMessage[] {
  const open = messages.filter((message) =>
    message.remoteAsks?.some((ask) => ask.reply?.kind !== 'answer')
  )
  if (open.length === 0) {
    return [...messages]
  }
  const db = groups.runtime.getOrchestrationDb()
  const statement = db.db.prepare(
    `SELECT m.* FROM messages m
     JOIN peer_mail_messages p ON p.message_id = m.id
     JOIN peer_mail_conversations c ON c.conversation_id = p.conversation_id
     WHERE c.role = 'home' AND c.local_party = ? AND c.environment_id = ?
       AND m.to_handle = ? AND m.thread_id = ?
     ORDER BY m.sequence`
  )
  const updated = new Map<string, BotGroupMessage>()
  const read: string[] = []
  groups.store.transaction(() => {
    for (const { id } of open) {
      const current = groups.store.message(id)
      if (!current?.remoteAsks) {
        continue
      }
      const address = botGroupRoomMailAddress(current.groupId)
      let changed = false
      const remoteAsks = current.remoteAsks.map((ask) => {
        if (ask.reply?.kind === 'answer') {
          return ask
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: m.* over messages returns its row shape.
        const rows = statement.all(
          address,
          ask.environmentId,
          address,
          ask.requestId
        ) as MessageRow[]
        read.push(...rows.filter((row) => row.read === 0).map((row) => row.id))
        const answer = rows.find((row) => isBotAnswer(row, ask.requestId))
        if (answer) {
          changed = true
          return {
            ...ask,
            state: 'sent' as const,
            reply: {
              kind: 'answer' as const,
              text: answer.body.slice(0, SAVED_ANSWER_MAX),
              ...(answer.body.length > SAVED_ANSWER_MAX ? { truncated: true as const } : {})
            }
          }
        }
        if (rows.length > 0 && !ask.reply) {
          changed = true
          return { ...ask, state: 'sent' as const, reply: { kind: 'notice' as const } }
        }
        return ask
      })
      if (changed) {
        const next = { ...current, remoteAsks }
        groups.store.update(next)
        updated.set(id, next)
      }
    }
  })
  if (read.length > 0) {
    db.markAsRead(read)
  }
  return messages.map((message) => updated.get(message.id) ?? message)
}

/** The bot's own answer, which carries the question's id; a notice carries none. */
function isBotAnswer(row: MessageRow, requestId: string): boolean {
  if (!row.payload) {
    return false
  }
  try {
    const payload: unknown = JSON.parse(row.payload)
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'requestId' in payload &&
      payload.requestId === requestId &&
      'botAnswer' in payload
    )
  } catch {
    return false
  }
}

/** Mail for a room's remote members arrived: copy it onto the room's posts, and open rooms re-read. */
export function remoteRoomMailArrived(groups: BotGroupRuntime, groupId: string): void {
  try {
    const group = groups.store.list().find((entry) => entry.id === groupId)
    if (!group) {
      return
    }
    for (const threadId of [undefined, ...(group.threads ?? []).map((thread) => thread.id)]) {
      collectRemoteAnswers(groups, groups.store.roomMessages(groupId, threadId, 40))
    }
  } catch (error) {
    console.warn('[bot-groups] could not read a remote member answer', error)
  }
  groups.changed()
}
