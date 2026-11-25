import {
  botGroupRemoteKey,
  type BotGroupMessage,
  type BotGroupRemoteAsk
} from '../../shared/bots/bot-group'
import { botGroupRoomMailAddress } from '../../shared/bots/bot-group-room-mail'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../shared/agent-session/identity/orca-session-address'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import { peerMailPairing } from '../runtime/orchestration/federation/peer-mail/peer-mail-delivery'
import type { MessageRow } from '../runtime/orchestration/db/orchestration-records'
import type { BotGroupRuntime } from './bot-group-runtime'
import { deliverGroupLines, routeSpeech } from './bot-group-speech-routing'

const SAVED_ANSWER_MAX = 64_000

/** A returned room item has no authority until it joins the pinned ask and paired conversation. */
export function groupRemoteSpeech(
  groups: BotGroupRuntime,
  post: BotGroupMessage,
  ask: BotGroupRemoteAsk,
  mail: MessageRow
): boolean {
  const db = groups.runtime.getOrchestrationDb()
  const route = db.getPeerMailMessage(mail.id)
  const conversation = route && db.getPeerMailConversation(route.conversation_id)
  const roomAddress = botGroupRoomMailAddress(post.groupId)
  return Boolean(
    ask.interactive &&
    ask.conversationId &&
    conversation?.role === 'home' &&
    conversation.environment_id === ask.environmentId &&
    conversation.conversation_id === ask.conversationId &&
    conversation.local_party === roomAddress &&
    mail.to_handle === roomAddress &&
    mail.thread_id === ask.requestId &&
    isOrcaSessionId(ask.chatSessionId) &&
    route?.remote_party === formatOrcaSessionAddress(ask.chatSessionId) &&
    (!ask.pairing || ask.pairing === conversation.peer_fingerprint)
  )
}

export async function routeRemoteGroupMail(
  groups: BotGroupRuntime,
  groupId: string
): Promise<void> {
  const stored: BotGroupMessage[] = []
  const drained = runKeyedSerializedOperation(groups.queues, groupId, async () => {
    const db = groups.runtime.getOrchestrationDb()
    for (const { mailId, requestId, isPost } of groups.store.routes.pendingMailRoutes(groupId)) {
      if (!groups.runtime.bots.enabled()) {
        break
      }
      const post = groups.store.remoteAskMessage(requestId)
      const ask = post?.remoteAsks?.find((candidate) => candidate.requestId === requestId)
      const mail = db.getMessageById(mailId)
      const conversation = ask?.conversationId && db.getPeerMailConversation(ask.conversationId)
      if (
        !post ||
        !ask?.conversationId ||
        !conversation ||
        !mail ||
        !groupRemoteSpeech(groups, post, ask, mail) ||
        (isPost && (ask.reply?.kind !== 'answer' || !mail.body.trim()))
      ) {
        groups.store.routes.routedMail(mailId)
        continue
      }
      const server = await groups.runtime
        .resolveOrchestrationWorkerServer(ask.environmentId)
        .catch(() => null)
      if (!groups.runtime.bots.enabled()) {
        break
      }
      const room = groups.store.room(post.groupId, post.threadId)
      const member = room.remoteMembers?.find(
        (candidate) =>
          botGroupRemoteKey(candidate) === botGroupRemoteKey(ask) &&
          candidate.chatSessionId === ask.chatSessionId &&
          candidate.joinedAfter === ask.joinedAfter
      )
      if (
        !server ||
        peerMailPairing(server) !== conversation.peer_fingerprint ||
        !member ||
        ask.stopped
      ) {
        groups.store.routes.routedMail(mailId)
        continue
      }
      stored.push(
        ...(await routeSpeech(groups, post, {
          triggerId: mailId,
          speaker: { kind: 'remote', member, requestId, conversationId: ask.conversationId },
          reply: {
            full: mail.body,
            saved: isPost ? mail.body : mail.body.slice(-SAVED_ANSWER_MAX)
          },
          newPost: isPost,
          commit: () => groups.store.routes.routedMail(mailId)
        }))
      )
    }
  })
  await drained.finally(() => deliverGroupLines(groups, stored))
}
