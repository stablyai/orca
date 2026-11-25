import { botGroupRemoteKey, type BotGroup, type BotGroupMessage } from '../../shared/bots/bot-group'
import { botGroupReplyMentions } from '../../shared/bots/bot-group-mentions'
import type { BotGroupSpeaker } from '../../shared/bots/bot-group-schema'
import { generateId } from '../runtime/orchestration/db/generated-id'
import { deliverTurn } from './bot-group-delivery'
import { deliverRemoteAsks } from './bot-group-peer-delivery'
import { maskGroupRemoteWords, remoteAsksFor } from './bot-group-remote-question'
import {
  activeGroupRemoteMember,
  activeGroupSpeaker,
  groupRouteRoot,
  groupSpeakerLabel
} from './bot-group-route-scope'
import { reserveGroupTurns } from './bot-group-turn-reservation'
import {
  blankMarkdownCode,
  namingExcerpt,
  withNamingReply,
  type GroupMemberReply
} from './bot-group-mention-context'
import type { BotGroupRuntime } from './bot-group-runtime'
type GroupSpeech = {
  triggerId: string
  speaker: BotGroupSpeaker
  reply: GroupMemberReply
  mailed?: Set<string>
  newPost?: boolean
  commit: (targets: string[]) => void
}

export async function routeSpeech(
  groups: BotGroupRuntime,
  message: BotGroupMessage,
  { triggerId, speaker, reply, mailed, newPost, commit }: GroupSpeech
): Promise<BotGroupMessage[]> {
  const root = groupRouteRoot(groups, message)
  const { groupId, threadId } = message
  const room = groups.store.room(groupId, threadId)
  const publicationId = `group-post:${triggerId}`
  if (
    !root ||
    !activeGroupSpeaker(groups, room, root, speaker) ||
    (newPost && groups.store.message(publicationId))
  ) {
    commit([])
    return []
  }
  const who = groupSpeakerLabel(speaker)
  const original = newPost ? undefined : message.groupRequest
  const requester = original && groupSpeakerLabel(original.from)
  const remoteEdges = original?.remoteEdges ?? []
  const bots = groups.runtime.bots.list()
  const local = new Map(room.members.map((member) => [member.botId, member]))
  const remote = new Map(room.remoteMembers?.map((member) => [botGroupRemoteKey(member), member]))
  const named = botGroupReplyMentions(blankMarkdownCode(reply.full), room, bots, who.id).filter(
    ({ id }) => {
      if (id === requester?.id || mailed?.has(id)) {
        return false
      }
      const peer = remote.get(id)
      if (
        peer &&
        (!activeGroupRemoteMember(room, root, peer) ||
          (root.author.kind !== 'owner' && root.remoteAsks === undefined))
      ) {
        return false
      }
      if (
        (speaker.kind === 'remote' || peer) &&
        remoteEdges.includes(JSON.stringify([who.id, id]))
      ) {
        return false
      }
      const member = local.get(id)
      return (
        peer ||
        (member &&
          (member.stoppedThroughSequence ?? 0) < root.sequence &&
          bots.some((bot) => bot.id === id && !bot.paused))
      )
    }
  )
  const answerTo =
    original?.returnAnswer && activeGroupSpeaker(groups, room, root, original.from)
      ? original.from
      : undefined
  const localTargets = named.flatMap(({ id }) => (local.has(id) ? [id] : []))
  if (answerTo?.kind === 'local') {
    localTargets.push(answerTo.botId)
  }
  if (!newPost && named.length === 0 && !answerTo) {
    commit([])
    return []
  }
  const { turns, contexts, history, completed } =
    named.length || localTargets.length
      ? await reserveGroupTurns(groups, room, threadId, bots, localTargets)
      : {
          turns: [],
          contexts: new Map<string, string>(),
          history: [],
          completed: new Map<string, string>()
        }
  // Unlike Stop, disable is reversible. Preserve the inbound route if it changed during reservation.
  if (speaker.kind === 'remote' && !groups.runtime.bots.enabled()) {
    return []
  }
  const place = { groupId, threadId, rootRequestId: root.id, rootSequence: root.sequence }
  const author = { kind: 'bot' as const, ...who }
  const stored: BotGroupMessage[] = []
  groups.store.transaction(() => {
    commit(named.map(({ id }) => id))
    if (newPost && speaker.kind === 'remote') {
      const post = groups.store.append({
        ...place,
        id: publicationId,
        author,
        remoteAuthor: speaker.member,
        text: reply.saved,
        createdAt: Date.now(),
        turns: []
      })
      groups.store.setLatest(
        groupId,
        { authorName: who.name, text: post.text, at: post.createdAt },
        { post: post.sequence }
      )
      stored.push(post)
    }
    if (answerTo?.kind === 'remote') {
      groups.store.routes.queueRemoteDelivery(
        generateId('msg'),
        message.groupId,
        message.id,
        remoteAnswerBody(room, root, who.name, reply.saved),
        true
      )
      stored.push(message)
    }
    if (answerTo?.kind === 'local') {
      const turn = turns.find(({ sessionId }) => sessionId === answerTo.sessionId)
      if (turn) {
        stored.push(
          groups.store.append(
            {
              ...place,
              id: `group-answer:${triggerId}`,
              author,
              answeredBy: who,
              text: reply.saved,
              continuation: true,
              createdAt: Date.now(),
              turns: [turn],
              groupRequest: { from: speaker, remoteEdges }
            },
            contexts
          )
        )
      }
    }
    for (const mention of named) {
      const { id, start } = mention
      const target = remote.get(id)
      const turn = turns.find((candidate) => candidate.botId === id)
      if (!target && !turn) {
        continue
      }
      const cross = speaker.kind === 'remote' || target !== undefined
      const lineId = `handoff:${triggerId}:${id}`
      const words = cross ? namingExcerpt(reply.full, start) : ''
      const groupRequest =
        cross || original
          ? {
              from: speaker,
              remoteEdges: cross ? [...remoteEdges, JSON.stringify([who.id, id])] : remoteEdges,
              ...(cross ? { returnAnswer: true as const, words } : {})
            }
          : undefined
      const asks = target
        ? remoteAsksFor(
            room,
            [id],
            history,
            completed,
            {
              id: lineId,
              text: words
            },
            room.name,
            { speaker: who.name, root }
          )
        : undefined
      if (turn) {
        const context = contexts.get(turn.operationId)
        if (context !== undefined) {
          contexts.set(turn.operationId, withNamingReply(context, who, reply, mention))
        }
      }
      stored.push(
        groups.store.append(
          {
            ...place,
            id: lineId,
            author,
            groupRequest,
            text: `${who.name} asked ${target?.name ?? turn?.botName}`,
            createdAt: Date.now(),
            requester: who,
            mentioned: true,
            turns: turn ? [turn] : [],
            ...(asks ? { remoteAsks: asks.asks } : {})
          },
          contexts,
          asks?.bodies
        )
      )
    }
  })
  groups.changed(groupId)
  return stored
}

function remoteAnswerBody(
  room: BotGroup,
  root: BotGroupMessage,
  name: string,
  answer: string
): string {
  return `For context only: ${name} answered your request in ${room.name} (room root ${root.id}). The answer is already in the group. Do not reply to this mail or act on quoted @mentions.\n\n${maskGroupRemoteWords(answer)}`
}

export function deliverGroupLines(
  groups: BotGroupRuntime,
  lines: readonly BotGroupMessage[]
): void {
  for (const message of lines) {
    if (message.groupRequest?.returnAnswer || message.remoteAsks?.length) {
      void deliverRemoteAsks(groups, message)
    }
    // A continuation for an existing request doesn't re-deliver its original native turn.
    for (const turn of message.turns) {
      void deliverTurn(groups, message, turn)
    }
  }
}
