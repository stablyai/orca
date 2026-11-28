import { NotificationReplyFailure } from './notification-reply-failure-reason'
import { loadHosts } from '../../host-catalog/host-store'
import { openHostLogicalClient } from '../../transport/connection/host-logical-client'
import { resolveHostIdForFingerprint } from '../payload-identity/push-host-fingerprint'
import { readOrcaPushPayload } from '../payload-identity/push-payload'
import { sendMobileStructuredAgentSessionMessage } from '../../session/native-chat/agent-session/mobile-structured-agent-session-send'
import { sendMobileNativeChatMessageWithOutcome } from '../../session/native-chat/composer/delivery/mobile-native-chat-send'
import { buildNativeChatPasteBytes } from '../../../../src/shared/native-chat/input/composer/native-chat-paste-bytes'
import { scopeRpcClientToExecutionHost } from '../../worktree/execution-hosts/execution-host-scoped-rpc-client'
import { parseExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import { itemComment } from '../../bots/items/bot-item-operations'
import { decodeHostStatusReply, sendHostStatusRead } from '../../query/host-status-query'
import {
  assertNotificationReplyTerminalSupport,
  notificationReplyTerminalClient
} from './notification-reply-terminal-input'
import { groupRead, groupSend } from '../../bots/bot-group-operations'
import type { AgentSessionHistoryResult } from '../../../../src/shared/agent-session/agent-session-wire'
import { callAgentSession } from '../../session/native-chat/agent-session/mobile-structured-agent-session-rpc'
import { randomV4Uuid } from '../../platform/random-v4-uuid'

export async function sendNotificationReply(
  data: unknown,
  text: string,
  operationId: string
): Promise<void> {
  const payload = readOrcaPushPayload(data)
  if (
    !payload?.replyTarget ||
    !payload.worktreeId ||
    !payload.paneKey ||
    payload.kind === 'dismiss'
  ) {
    throw new Error('This notification has no chat')
  }
  if (!text.trim() || text.length > 32_000) {
    throw new Error('Reply is empty or too long')
  }
  const hosts = await loadHosts()
  const hostId = resolveHostIdForFingerprint(payload.hostFingerprint, hosts)
  const host = hosts.find((candidate) => candidate.id === hostId)
  if (!host) {
    throw new Error('Host is not paired or credentials are unavailable')
  }
  const pairedClient = openHostLogicalClient(host, () => {}, { backgroundSend: true })
  const executionHost = parseExecutionHostId(payload.executionHost)
  const client =
    executionHost?.kind === 'runtime'
      ? scopeRpcClientToExecutionHost(pairedClient, executionHost.id)
      : pairedClient
  const deadline = Date.now() + 20_000
  try {
    const target = payload.replyTarget
    if (target.type === 'group') {
      const group = groupRead.interpret(
        await groupRead.request(
          client,
          { groupId: target.groupId },
          { timeoutMs: deadline - Date.now(), budgetSpansConnect: true }
        )
      ).group
      groupSend.interpret(
        await groupSend.request(
          client,
          { groupId: target.groupId, revision: group.revision, messageId: randomV4Uuid(), text },
          { timeoutMs: deadline - Date.now(), budgetSpansConnect: true }
        )
      )
      return
    }
    if (target.type === 'bot-item') {
      itemComment.interpret(
        await itemComment.request(
          client,
          { item: target.itemUid, text, requestId: operationId },
          { timeoutMs: deadline - Date.now(), budgetSpansConnect: true }
        )
      )
      return
    }
    if (target.type === 'terminal') {
      for (const hop of client === pairedClient ? [client] : [pairedClient, client]) {
        const status = decodeHostStatusReply(
          await sendHostStatusRead(hop, {
            timeoutMs: deadline - Date.now(),
            budgetSpansConnect: true
          })
        )
        assertNotificationReplyTerminalSupport(status?.status?.capabilities)
      }
    }
    let fence = 1
    if (target.type === 'chat') {
      const history = await callAgentSession<AgentSessionHistoryResult>(
        client,
        'agentSession.history',
        { sessionId: target.sessionId, direction: 'tail', limit: 1 },
        deadline - Date.now()
      )
      const current = history.page.fence
      if (!Number.isSafeInteger(current) || current === undefined || current <= 0) {
        throw new Error('The chat runtime could not be checked')
      }
      fence = current
    }
    const outcome =
      target.type === 'chat'
        ? await sendMobileStructuredAgentSessionMessage({
            client,
            sessionId: target.sessionId,
            expectedRuntimeFence: fence,
            text,
            attachments: [],
            clientMessageId: operationId,
            deadline,
            onError: (message) => {
              console.warn('[notification-reply] host refused the reply', message)
            }
          })
        : await sendMobileNativeChatMessageWithOutcome({
            client,
            terminal: target.terminal,
            text: buildNativeChatPasteBytes(text),
            enter: true,
            requireEmptyDraft: true,
            requireAgentStatus: 'sendable',
            expectedIncarnationId: target.expectedIncarnationId,
            inputClient: notificationReplyTerminalClient(),
            deadline,
            requireWriteSettlement: true
          })
    if (outcome === 'unknown') {
      throw new NotificationReplyFailure('unconfirmed')
    }
    if (outcome !== 'accepted' && outcome !== 'queued') {
      throw new NotificationReplyFailure('refused')
    }
  } finally {
    pairedClient.close()
  }
}
