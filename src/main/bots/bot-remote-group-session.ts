import { createHash } from 'node:crypto'
import type { Bot } from '../../shared/bot-types'
import { REMOTE_BOT_GROUP_SESSION_PREFIX } from '../../shared/bots/bot-remote-group-session'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { StructuredMailboxPointerHost } from '../runtime/orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host-contract'
import { botRequestRecord } from '../runtime/rpc/methods/orchestration/messaging/bot-request-record'
import { requireStructuredHost, startBotSession } from './bot-chat-session'

const queues = new Map<string, Promise<void>>()

export function remoteBotGroupSessionId(
  peerFingerprint: string,
  group: { id: string; threadId?: string },
  botId: string
): string {
  const key = JSON.stringify([peerFingerprint, group.id, group.threadId ?? null, botId])
  return `${REMOTE_BOT_GROUP_SESSION_PREFIX}${createHash('sha256').update(key).digest('hex')}`
}

/** Existing memberships may still name Home; the paired room always owns a separate session. */
export function inRemoteGroupSession<T>(
  runtime: OrcaRuntimeService,
  bot: Bot,
  sessionId: string,
  admit: (sessionId: string) => T
): Promise<T> {
  return runKeyedSerializedOperation(queues, sessionId, async () => {
    const host = await requireStructuredHost(runtime)
    if (!host.deps.store.getConversation(sessionId)) {
      await startBotSession(runtime, bot, { sessionId, background: true })
    }
    return admit(sessionId)
  })
}

/** Save the exact delivery attempt before admission; only provider-accepted turns can answer it. */
export function recordRemoteGroupSend(
  runtime: OrcaRuntimeService,
  input: Parameters<StructuredMailboxPointerHost['send']>[0]
): void {
  const db = runtime.getOrchestrationDb()
  const mail = input.body.from?.orchestration
  if (mail?.message !== 'mail-notice' || mail.messages.length !== 1) {
    throw new Error('A remote group turn must carry one authorized group request.')
  }
  const messageId = mail.messages[0]!.messageId
  const record = botRequestRecord(db, messageId)
  // Reports and status mail keep their usual delivery; only a group question grants an answer route.
  if (!record?.remoteGroup) {
    return
  }
  const original = db.getMessageById(messageId)
  if (
    record?.remoteGroup?.sessionId !== input.sessionId ||
    original?.to_handle !== `orca_session_id:${input.sessionId}`
  ) {
    throw new Error('This mail does not belong to the remote group conversation.')
  }
  db.db.prepare('UPDATE bot_requests SET record = ? WHERE message_id = ?').run(
    JSON.stringify({
      ...record,
      remoteGroup: { ...record.remoteGroup, operationId: input.operationId }
    }),
    messageId
  )
}
