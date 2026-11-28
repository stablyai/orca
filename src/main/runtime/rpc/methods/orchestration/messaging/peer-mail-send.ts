import type { z } from 'zod'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationEntryCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'
import type { OrchestrationCompatibilityCallerAuthority } from '../../../../orchestration/terminal-authority/orchestration-compatibility-authority'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  deliverPeerMail,
  peerMailMessageId,
  peerMailPairing,
  peerMailSender,
  peerMailSenderLabel,
  requirePeerMailServer
} from '../../../../orchestration/federation/peer-mail/peer-mail-delivery'
import type { RpcContext } from '../../../core'
import { parseBotAddress } from '../../../../../../shared/bot-roster'
import { recordReceiptBeforeNudge } from './mutation-replay-nudge'
import { peerMailLocalCaller } from './peer-mail-local-caller'
import { peerMailSendingAskers } from './peer-mail-sending-askers'
import { sendClientAsk } from './client-ask-send'
import type { SendParams } from './send-params'
import type { SendRecipientWarning } from './recipient-routing'
import {
  assertPeerMailFilesAddress,
  assertPeerMailServerTakesFiles,
  uploadPeerMailFiles
} from './peer-mail-files'
import { peerMailStoredNothing, withUnattachedUploads } from './peer-mail-unattached'
import { PeerMailMessageType } from '../../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import {
  forgetPeerQuestionOut,
  recordPeerQuestionOut
} from '../../../../orchestration/federation/peer-mail/peer-questions-out'

const NOTHING_SENT = { effectsApplied: false } as const

/** `send --on <server>`: this Orca carries the mail and keeps the conversation the replies come back on. */
export async function sendPeerMail(args: {
  params: z.infer<typeof SendParams> & { on: string }
  runtime: OrcaRuntimeService
  orchestrationCaller: OrchestrationEntryCaller | undefined
  attestedCaller: OrchestrationCompatibilityCallerAuthority | undefined
  orchestrationMutation: { callerFingerprint: string; requestId: string } | undefined
  recordMutationReceipt: ((receipt: unknown) => void) | undefined
}): Promise<unknown> {
  const { params, runtime } = args
  const to = params.to
  if (!to || /^(run|dispatch|task):/.test(to) || to.startsWith('@')) {
    throw new OrchestrationError(
      'invalid_argument',
      `--on sends to one agent or bot on that server: --to term_…, orca_session_id:… or bot:<name>${to ? `, not ${to}` : ''}. Nothing was sent.`,
      NOTHING_SENT
    )
  }
  const ordinaryType = PeerMailMessageType.safeParse(params.type ?? 'status')
  if (!ordinaryType.success) {
    throw new OrchestrationError(
      'invalid_argument',
      `--type ${params.type} requires Dispatch authority on its Run home. Send it through that Dispatch without --on. Nothing was sent.`,
      NOTHING_SENT
    )
  }
  const type = ordinaryType.data
  if (params.payload !== undefined) {
    throw new OrchestrationError(
      'invalid_argument',
      '--on carries a subject and body; payload fields such as --task-id or --report-path name work on this Orca only. Nothing was sent.',
      NOTHING_SENT
    )
  }
  assertPeerMailFilesAddress(params)
  const caller = peerMailLocalCaller({ ...args, from: params.from })
  const toBot =
    parseBotAddress(to) !== null || params.chat !== undefined || params.item !== undefined
  const server = await requirePeerMailServer(runtime, params.on, toBot, type)
  assertPeerMailServerTakesFiles(server, params)
  const askers = await peerMailSendingAskers(runtime, args.orchestrationCaller, caller, {
    ...params,
    to
  })
  const conversation = runtime.getOrchestrationDb().openHomePeerMailConversation({
    environmentId: server.environmentId,
    peerFingerprint: peerMailPairing(server),
    localParty: caller.address,
    localPaneKey: caller.paneKey
  })
  const id = peerMailMessageId(args.orchestrationMutation)
  const attachments = await uploadPeerMailFiles(runtime, server, params)
  const warnings: SendRecipientWarning[] = []
  const db = runtime.getOrchestrationDb()
  // Until the server is asked, nothing was delivered, whatever fails.
  let recorded = false
  let delivering = false
  try {
    const senderLabel = peerMailSenderLabel(runtime, caller.address)
    const sender = peerMailSender(runtime, caller.address)
    if (type === 'question') {
      // Kept until its answer or notice comes back, so an unpair can tell the asker none will;
      // recorded first, so an answer pulled before delivery returns still settles it.
      recordPeerQuestionOut(db, {
        messageId: id,
        conversationId: conversation.conversation_id,
        environmentId: server.environmentId,
        peerFingerprint: conversation.peer_fingerprint,
        asker: caller.address,
        threadId: params.threadId
      })
      recorded = true
    }
    delivering = true
    const held = await deliverPeerMail(runtime, server, conversation, {
      id,
      to,
      senderLabel,
      subject: params.subject,
      body: params.body,
      type,
      priority: params.priority,
      threadId: params.threadId,
      chat: params.chat,
      item: params.item,
      attachments,
      sender,
      ...(askers ? { askers } : {})
    })
    warnings.push(...held)
  } catch (error) {
    if (recorded) {
      // A cleanup that fails too mustn't hide why the send failed, or the files it left there.
      try {
        forgetPeerQuestionOut(db, id)
      } catch (cleanup) {
        console.warn('[orchestration] forgetting a failed peer question failed', cleanup)
      }
    }
    // A refusal names the files it left there; a timeout may yet have delivered them with the mail.
    throw !delivering || peerMailStoredNothing(error)
      ? withUnattachedUploads(error, server, { copied: attachments?.length ?? 0 })
      : error
  }
  return recordReceiptBeforeNudge(
    args.recordMutationReceipt,
    { message: { id, to }, server: server.name, ...(warnings.length > 0 ? { warnings } : {}) },
    () => runtime.ensureOrchestrationPeerMailRelay(server.environmentId),
    { kind: 'federation', environmentId: server.environmentId }
  )
}

type SendInput = z.infer<typeof SendParams>

/** `send --on` goes to the paired server and `send --on-client` to a paired computer; every other
 *  send, and every replay, runs `send`. */
export function withPeerMailSend<R>(
  send: (params: SendInput, ctx: RpcContext) => Promise<R>
): (params: SendInput, ctx: RpcContext) => Promise<unknown> {
  return async (params, ctx) => {
    const { on, onClient } = params
    if ((on === undefined && onClient === undefined) || ctx.replayedMutationReceipt !== undefined) {
      return await send(params, ctx)
    }
    const attested = ctx.orchestrationCompatibilityCallerAuthority
    if (onClient !== undefined) {
      return sendClientAsk({
        params: { ...params, onClient },
        runtime: ctx.runtime,
        orchestrationCaller: ctx.orchestrationCaller,
        attestedCaller: attested?.terminalHandle === params.from ? attested : undefined,
        orchestrationMutation: ctx.orchestrationMutation,
        recordMutationReceipt: ctx.recordMutationReceipt
      })
    }
    if (on === undefined) {
      return await send(params, ctx)
    }
    return await sendPeerMail({
      params: { ...params, on },
      runtime: ctx.runtime,
      orchestrationCaller: ctx.orchestrationCaller,
      attestedCaller: attested?.terminalHandle === params.from ? attested : undefined,
      orchestrationMutation: ctx.orchestrationMutation,
      recordMutationReceipt: ctx.recordMutationReceipt
    })
  }
}
