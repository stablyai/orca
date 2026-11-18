import { createHash } from 'node:crypto'
import { ORCHESTRATION_PEER_MAIL_RUNTIME_CAPABILITY } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { PeerMailConversationRow } from '../../db/federation/peer-mail-store'
import { generateId } from '../../db/generated-id'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationWorkerServer } from '../environment-transport'

export type PeerMailRuntime = Pick<
  OrcaRuntimeService,
  | 'getOrchestrationDb'
  | 'resolveOrchestrationWorkerServer'
  | 'callOrchestrationWorkerServer'
  | 'notifyMessageArrived'
  | 'readMachineName'
  | 'getTerminalHandleForPaneKey'
>

const NOTHING_SENT = { effectsApplied: false } as const
const RuntimeStatusCapabilities = z.object({ capabilities: z.array(z.string()).optional() })
const DELIVER_TIMEOUT_MS = 15_000

/** "term_9f3c on Jinwoo's Mac": who sent it, and the Orca server it came from. */
export function peerMailSenderLabel(runtime: PeerMailRuntime, sender: string): string {
  return `${sender} on ${runtime.readMachineName()}`
}

/** A retried mutation reuses its message id, so the server stores the mail once. */
export function peerMailMessageId(
  mutation: { callerFingerprint: string; requestId: string } | undefined
): string {
  if (!mutation) {
    return generateId('msg')
  }
  const digest = createHash('sha256')
    .update(`${mutation.callerFingerprint}\0${mutation.requestId}`)
    .digest('hex')
  return `msg_${digest.slice(0, 12)}`
}

/** Refuses before any effect when the server's Orca cannot receive mail or queue its replies. */
export async function requirePeerMailServer(
  runtime: PeerMailRuntime,
  selector: string
): Promise<OrchestrationWorkerServer> {
  const server = await runtime.resolveOrchestrationWorkerServer(selector)
  const status = RuntimeStatusCapabilities.safeParse(
    await runtime.callOrchestrationWorkerServer(
      server.environmentId,
      'status.get',
      undefined,
      DELIVER_TIMEOUT_MS,
      undefined,
      { expectedEnvironmentPairingRevision: server.pairingRevision }
    )
  )
  if (
    !status.success ||
    !status.data.capabilities?.includes(ORCHESTRATION_PEER_MAIL_RUNTIME_CAPABILITY)
  ) {
    throw new OrchestrationError(
      'server_mail_unsupported',
      `Server ${server.name} runs an older Orca that cannot receive agent mail from another server. Update Orca on ${server.name}, then send again. Nothing was sent.`,
      { ...NOTHING_SENT, server: server.name }
    )
  }
  return server
}

/** The pairing credential the server knows this Orca by; a re-pair starts new conversations under it. */
export function peerMailPairing(server: OrchestrationWorkerServer): string {
  return server.homePeerFingerprint ?? server.peerFingerprint
}

/** Hands one message to the paired server; it stores it once and delivers it with its own mail code. */
export async function deliverPeerMail(
  runtime: PeerMailRuntime,
  server: OrchestrationWorkerServer,
  conversation: PeerMailConversationRow,
  message: {
    id: string
    to: string
    senderLabel: string
    subject: string
    body?: string
    type?: 'status' | 'handoff'
    priority?: 'normal' | 'high' | 'urgent'
    threadId?: string
  }
): Promise<void> {
  await runtime.callOrchestrationWorkerServer(
    server.environmentId,
    'orchestration.peerMailDeliver',
    {
      conversationId: conversation.conversation_id,
      messageId: message.id,
      to: message.to,
      senderLabel: message.senderLabel,
      subject: message.subject,
      ...(message.body !== undefined ? { body: message.body } : {}),
      ...(message.type ? { type: message.type } : {}),
      ...(message.priority ? { priority: message.priority } : {}),
      ...(message.threadId ? { threadId: message.threadId } : {})
    },
    DELIVER_TIMEOUT_MS,
    undefined,
    { expectedEnvironmentPairingRevision: server.pairingRevision }
  )
}

/** Where a pulled reply lands: the opener's current mailbox, following a terminal's remint by pane. */
export function peerMailLocalRecipient(
  runtime: PeerMailRuntime,
  conversation: PeerMailConversationRow
): string {
  const party = conversation.local_party ?? ''
  const reminted = conversation.local_pane_key
    ? runtime.getTerminalHandleForPaneKey(conversation.local_pane_key)
    : null
  return reminted ?? party
}
