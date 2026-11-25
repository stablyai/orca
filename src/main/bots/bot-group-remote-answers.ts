import { ZodError } from 'zod'
import type { BotGroupMessage } from '../../shared/bots/bot-group'
import type { MessageRow } from '../runtime/orchestration/db/orchestration-records'
import { botGroupRoomMailAddress } from '../../shared/bots/bot-group-room-mail'
import type { BotGroupRuntime } from './bot-group-runtime'
import { isRemoteAskInFlight } from './bot-group-peer-delivery'
import { groupRemoteSpeech, routeRemoteGroupMail } from './bot-group-remote-mail-routing'

// How remote members' answers, which come back by mail, reach their posts and the room's readers.

/** A remote answer kept on its post; the whole answer stays in this computer's mail. */
const SAVED_ANSWER_MAX = 64_000
/** A room page's answer text, so a page of long answers stays far under the reply limit. */
const PAGE_ANSWER_BUDGET = 1_000_000
const PAGE_ANSWER_MAX = 16_000
const GROUP_POST_PAYLOAD = '{"groupPost":true}'

/** Asks as a reader sees them: a `sending` ask whose handover is no longer running may or may not
 *  have reached its computer; its answer still lands if one comes. Long answers, remote ones and
 *  members' mailed answers alike, are shortened to the page's budget, newest posts first, so a
 *  page stays readable; the whole answer stays in mail. */
export function presentPageAnswers(messages: readonly BotGroupMessage[]): BotGroupMessage[] {
  let budget = PAGE_ANSWER_BUDGET
  const take = (text: string) => {
    const kept = text.slice(0, Math.max(0, Math.min(PAGE_ANSWER_MAX, budget)))
    budget -= kept.length
    return kept
  }
  const shown = new Map<string, BotGroupMessage>()
  for (const message of messages.toReversed()) {
    const turns = message.turns.some((turn) => turn.answer)
      ? message.turns.map((turn) => (turn.answer ? { ...turn, answer: take(turn.answer) } : turn))
      : message.turns
    const postText =
      message.remoteAuthor || message.continuation ? take(message.text) : message.text
    const post =
      postText.length < message.text.length ? { ...message, text: `${postText}…` } : message
    if (!message.remoteAsks?.length) {
      shown.set(message.id, { ...post, turns })
      continue
    }
    shown.set(message.id, {
      ...post,
      turns,
      remoteAsks: message.remoteAsks.map((ask) => {
        const state =
          ask.state === 'sending' && !isRemoteAskInFlight(ask.requestId)
            ? ('unknown' as const)
            : ask.state
        if (ask.reply?.kind !== 'answer') {
          return { ...ask, state }
        }
        const answer = take(ask.reply.text)
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
       AND (?5 IS NULL OR c.conversation_id = ?5)
       AND m.payload IS NOT ?
     ORDER BY m.sequence`
  )
  const updated = new Map<string, BotGroupMessage>()
  const read: string[] = []
  const roomsToRoute = new Set<string>()
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
          ask.requestId,
          ask.conversationId ?? null,
          GROUP_POST_PAYLOAD
        ) as MessageRow[]
        read.push(...rows.filter((row) => row.read === 0).map((row) => row.id))
        const answer = rows.find(
          (row) =>
            isBotAnswer(row, ask.requestId) &&
            (!ask.interactive || groupRemoteSpeech(groups, current, ask, row))
        )
        if (answer) {
          if (ask.interactive) {
            groups.store.routes.stageMailRoute(answer.id, current.groupId, ask.requestId, false)
            roomsToRoute.add(current.groupId)
          }
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
        if (rows.some((row) => !isBotAnswer(row, ask.requestId)) && !ask.reply) {
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
  for (const groupId of roomsToRoute) {
    drainRoomRoutes(groups, groupId)
  }
  if (read.length > 0) {
    db.markAsRead(read, { kind: 'orca' })
  }
  return messages.map((message) => updated.get(message.id) ?? message)
}

/** The bot's own answer, which carries the question's id; a notice carries none. */
export function isBotAnswer(row: Pick<MessageRow, 'payload'>, requestId: string): boolean {
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

/** Where a room mail goes: onto its post; settled, when no post will ever take it (none, another
 *  group's, or one whose record can't be read); or left unread, when it may be placed later. */
type MailPlace = { post: BotGroupMessage } | 'settle' | 'wait'

function placeMail(groups: BotGroupRuntime, groupId: string, threadId: unknown): MailPlace {
  if (!threadId) {
    return 'settle'
  }
  try {
    const post = groups.store.remoteAskMessage(String(threadId))
    if (!post) {
      // Posts are indexed when stored, before their question is sent, and older ones when the
      // store opens; only when that pass failed may a later start still place this mail.
      return groups.store.remoteAsksIndexed ? 'settle' : 'wait'
    }
    return post.groupId === groupId ? { post } : 'settle'
  } catch (error) {
    console.warn('[bot-groups] could not read the post a remote answer is for', error)
    return error instanceof ZodError || error instanceof SyntaxError ? 'settle' : 'wait'
  }
}

/** Mail for a room's remote members arrived: copy it onto the posts it answers, and open rooms
 *  re-read. Only the room's unread mail is read, each found by the post its question went with,
 *  so no room's history is read here. Mail is marked read once it is on its post or no post will
 *  take it, so it isn't looked up on every arrival; a room read still finds read mail by its
 *  question's id. Mail whose post couldn't be written stays unread for the next arrival. */
export function remoteRoomMailArrived(groups: BotGroupRuntime, groupId: string): void {
  try {
    const db = groups.runtime.getOrchestrationDb()
    const rows = db.db
      .prepare(
        'SELECT id, thread_id, payload FROM messages WHERE to_handle = ? AND read = 0 ORDER BY sequence'
      )
      .all(botGroupRoomMailAddress(groupId))
    if (rows.length === 0) {
      groups.changed(groupId)
      drainRoomRoutes(groups, groupId)
      return
    }
    if (!db.db.prepare('SELECT 1 FROM bot_groups WHERE id = ?').get(groupId)) {
      db.markAsRead(
        rows.map((row) => String(row.id)),
        { kind: 'orca' }
      )
      return
    }
    const settled: string[] = []
    const posts = new Map<string, { post: BotGroupMessage; mail: string[] }>()
    for (const row of rows) {
      const place = placeMail(groups, groupId, row.thread_id)
      if (place === 'settle') {
        settled.push(String(row.id))
      } else if (place !== 'wait') {
        if (row.payload === GROUP_POST_PAYLOAD) {
          groups.store.routes.stageMailRoute(String(row.id), groupId, String(row.thread_id), true)
        }
        const entry = posts.get(place.post.id) ?? { post: place.post, mail: [] }
        entry.mail.push(String(row.id))
        posts.set(place.post.id, entry)
      }
    }
    // One post at a time, so a post that can't be merged keeps no other answer back.
    for (const { post, mail } of posts.values()) {
      try {
        collectRemoteAnswers(groups, [post])
        settled.push(...mail)
      } catch (error) {
        console.warn('[bot-groups] could not read a remote member answer', error)
      }
    }
    if (settled.length > 0) {
      db.markAsRead(settled, { kind: 'orca' })
    }
  } catch (error) {
    console.warn('[bot-groups] could not read a remote member answer', error)
  }
  groups.changed(groupId)
  drainRoomRoutes(groups, groupId)
}

function drainRoomRoutes(groups: BotGroupRuntime, groupId: string): void {
  if (groups.store.routes.pendingMailRoutes(groupId).length > 0) {
    void routeRemoteGroupMail(groups, groupId).catch((error: unknown) =>
      console.warn('[bot-groups] could not route a remote group post', error)
    )
  }
}

/** At startup: settle room mail that arrived while this build wasn't running, as if it had just
 *  come. Each room's unread mail is one seek in the inbox index. */
export function settleStoredRoomMail(groups: BotGroupRuntime): void {
  try {
    const db = groups.runtime.getOrchestrationDb().db
    const unread = db.prepare('SELECT 1 FROM messages WHERE to_handle = ? AND read = 0 LIMIT 1')
    for (const row of db.prepare('SELECT id FROM bot_groups').all()) {
      const groupId = String(row.id)
      if (unread.get(botGroupRoomMailAddress(groupId))) {
        remoteRoomMailArrived(groups, groupId)
      } else {
        drainRoomRoutes(groups, groupId)
      }
    }
  } catch (error) {
    console.warn('[bot-groups] could not read stored remote member answers', error)
  }
}
