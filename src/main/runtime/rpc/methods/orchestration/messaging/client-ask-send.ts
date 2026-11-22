import type { z } from 'zod'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationEntryCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'
import type { OrchestrationCompatibilityCallerAuthority } from '../../../../orchestration/terminal-authority/orchestration-compatibility-authority'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  peerMailMessageId,
  peerMailSender,
  peerMailSenderLabel
} from '../../../../orchestration/federation/peer-mail/peer-mail-delivery'
import { notifyPeerMailQueued } from '../../../../orchestration/federation/peer-mail/peer-mail-waiters'
import { recordPeerQuestionOut } from '../../../../orchestration/federation/peer-mail/peer-questions-out'
import { clientEnvironmentId } from '../../../../orchestration/federation/client-asks/client-ask-environment'
import { listeningClients } from '../../../../orchestration/federation/client-asks/client-ask-listeners'
import { queueClientItem } from '../../../../orchestration/federation/client-asks/client-ask-queue'
import { clientAskRootSession } from '../../../../orchestration/federation/client-asks/client-ask-root-session'
import { runLifecycleWriteTransaction } from '../../../../orchestration/db/lifecycle-write-transaction-runner'
import {
  type ClientAskPayload,
  PeerMailMessageType
} from '../../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { recordReceiptBeforeNudge } from './mutation-replay-nudge'
import type { SendParams } from './send-params'
import type { SendRecipientWarning } from './recipient-routing'
import { peerMailLocalCaller } from './peer-mail-send'

const NOTHING_SENT = { effectsApplied: false } as const

/** `send --on-client`: an agent here messages an agent on a paired computer, which pulls the mail
 *  while it is connected and decides there whether its agent takes it. Its replies come back here. */
export function sendClientAsk(args: {
  params: z.infer<typeof SendParams> & { onClient: string }
  runtime: OrcaRuntimeService
  orchestrationCaller: OrchestrationEntryCaller | undefined
  attestedCaller: OrchestrationCompatibilityCallerAuthority | undefined
  orchestrationMutation: { callerFingerprint: string; requestId: string } | undefined
  recordMutationReceipt: ((receipt: unknown) => void) | undefined
}): unknown {
  const { params, runtime } = args
  const to = params.to
  if (params.on !== undefined) {
    throw new OrchestrationError(
      'invalid_argument',
      '--on and --on-client name different machines; use one. Nothing was sent.',
      NOTHING_SENT
    )
  }
  if (!to || /^(run|dispatch|task):/.test(to) || to.startsWith('@')) {
    throw new OrchestrationError(
      'invalid_argument',
      `--on-client sends to one agent on that computer: --to bot:<name>${to ? `, not ${to}` : ''}. Nothing was sent.`,
      NOTHING_SENT
    )
  }
  const type = PeerMailMessageType.safeParse(params.type ?? 'status')
  if (!type.success) {
    throw new OrchestrationError(
      'invalid_argument',
      `--type ${params.type} can't go to another computer's agent. Use status, handoff or question. Nothing was sent.`,
      NOTHING_SENT
    )
  }
  if (params.payload !== undefined || params.chat !== undefined || params.item !== undefined) {
    throw new OrchestrationError(
      'invalid_argument',
      '--on-client carries a subject and body; --chat, --item and payload fields name work on this Orca only. Nothing was sent.',
      NOTHING_SENT
    )
  }
  const caller = peerMailLocalCaller({ ...args, from: params.from })
  const listening = listeningClients(runtime, params.onClient)
  if (listening.length > 1) {
    throw new OrchestrationError(
      'invalid_argument',
      `Two paired computers share the id ${params.onClient}. Nothing was sent.`,
      NOTHING_SENT
    )
  }
  const [client] = listening
  if (!client) {
    throw new OrchestrationError(
      'remote_runtime_unavailable',
      `${params.onClient} is offline: it isn't connected to this Orca right now. Nothing was sent.`,
      NOTHING_SENT
    )
  }
  const db = runtime.getOrchestrationDb()
  const environmentId = clientEnvironmentId(client.deviceId, client.installationId)
  const conversation = db.openHomePeerMailConversation({
    environmentId,
    peerFingerprint: client.fingerprint,
    localParty: caller.address,
    localPaneKey: caller.paneKey
  })
  const id = peerMailMessageId(args.orchestrationMutation)
  const payload: z.infer<typeof ClientAskPayload> = {
    to,
    senderLabel: peerMailSenderLabel(runtime, caller.address),
    subject: params.subject,
    ...(params.body !== undefined ? { body: params.body } : {}),
    type: type.data,
    ...(params.priority ? { priority: params.priority } : {}),
    ...(params.threadId ? { threadId: params.threadId } : {}),
    sender: peerMailSender(runtime, caller.address),
    rootSession: clientAskRootSession(db, caller.address)
  }
  runLifecycleWriteTransaction(db.db, 'client_ask_send', () => {
    if (type.data === 'question') {
      // Kept until its answer or notice comes back, so an ended pairing can tell the asker none will.
      recordPeerQuestionOut(db, {
        messageId: id,
        conversationId: conversation.conversation_id,
        environmentId,
        peerFingerprint: client.fingerprint,
        asker: caller.address,
        threadId: params.threadId
      })
    }
    queueClientItem(db, {
      conversationId: conversation.conversation_id,
      messageId: id,
      kind: 'client_ask',
      payload
    })
  })
  // That computer can't take uploads from here, so files never travel this way.
  const warnings: SendRecipientWarning[] = params.files?.length
    ? [
        {
          code: 'files_not_sent',
          recipient: to,
          message: `${client.name} can't receive files from this Orca, so the message went without them.`
        }
      ]
    : []
  return recordReceiptBeforeNudge(
    args.recordMutationReceipt,
    { message: { id, to }, client: client.name, ...(warnings.length > 0 ? { warnings } : {}) },
    () => notifyPeerMailQueued(db.db),
    { kind: 'messages', targets: [] }
  )
}
