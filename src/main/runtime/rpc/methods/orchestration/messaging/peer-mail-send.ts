import type { z } from 'zod'
import { withDispatchItemLink } from './dispatch-mail-item-link'
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
import { sendClientAsk } from './client-ask-send'
import type { SendParams } from './send-params'
import type { SendRecipientWarning } from './recipient-routing'
import { uploadPeerMailFiles } from './peer-mail-files'
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
  const caller = peerMailLocalCaller({ ...args, from: params.from })
  const toBot =
    parseBotAddress(to) !== null || params.chat !== undefined || params.item !== undefined
  const server = await requirePeerMailServer(runtime, params.on, toBot, type)
  const conversation = runtime.getOrchestrationDb().openHomePeerMailConversation({
    environmentId: server.environmentId,
    peerFingerprint: peerMailPairing(server),
    localParty: caller.address,
    localPaneKey: caller.paneKey
  })
  const id = peerMailMessageId(args.orchestrationMutation)
  // An Orca from before files keeps the words and drops the files, so they go only where they're taken.
  const files = server.takesFiles ? params.files : undefined
  const attachments = await uploadPeerMailFiles(runtime, server, { ...params, files })
  const warnings: SendRecipientWarning[] =
    params.files?.length && !server.takesFiles
      ? [
          {
            code: 'files_not_sent',
            recipient: to,
            message: `${server.name}'s Orca needs an update to receive files, so the message went without them.`
          }
        ]
      : []
  const db = runtime.getOrchestrationDb()
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
  }
  try {
    const held = await deliverPeerMail(runtime, server, conversation, {
      id,
      to,
      senderLabel: peerMailSenderLabel(runtime, caller.address),
      subject: params.subject,
      body: params.body,
      type,
      priority: params.priority,
      threadId: params.threadId,
      chat: params.chat,
      item: params.item,
      attachments,
      sender: peerMailSender(runtime, caller.address)
    })
    warnings.push(...held)
  } catch (error) {
    if (type === 'question') {
      forgetPeerQuestionOut(db, id)
    }
    throw error
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
      return await withDispatchItemLink(send)(params, ctx)
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
