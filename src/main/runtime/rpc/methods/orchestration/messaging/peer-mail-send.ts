import type { z } from 'zod'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationSessionCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'
import type { OrchestrationCompatibilityCallerAuthority } from '../../../../orchestration/terminal-authority/orchestration-compatibility-authority'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  deliverPeerMail,
  peerMailMessageId,
  peerMailPairing,
  peerMailSenderLabel,
  requirePeerMailServer
} from '../../../../orchestration/federation/peer-mail/peer-mail-delivery'
import type { RpcContext } from '../../../core'
import { recordReceiptBeforeNudge } from './mutation-replay-nudge'
import type { SendParams } from './send-params'
import type { ORCHESTRATION_SEND_METHODS } from './send-methods'

const NOTHING_SENT = { effectsApplied: false } as const

/** The agent on this Orca that mail sent elsewhere answers to: a chat by its session, a terminal by its live pane. */
export function peerMailLocalCaller(args: {
  runtime: OrcaRuntimeService
  from: string | undefined
  orchestrationCaller: OrchestrationSessionCaller | undefined
  attestedCaller: OrchestrationCompatibilityCallerAuthority | undefined
}): { address: string; paneKey: string | null } {
  if (args.orchestrationCaller) {
    return { address: args.orchestrationCaller.address, paneKey: null }
  }
  const paneKey =
    args.from === undefined
      ? null
      : (args.attestedCaller?.paneKey ?? args.runtime.getLiveTerminalPaneKey(args.from))
  if (!args.from || !paneKey) {
    throw new OrchestrationError(
      'invalid_argument',
      '--on needs a terminal or chat agent on this Orca to receive the replies. Run it from that agent. Nothing was sent.',
      NOTHING_SENT
    )
  }
  if (args.runtime.getOrchestrationDb().findActiveRemoteAttachmentForPane(paneKey)) {
    throw new OrchestrationError(
      'invalid_argument',
      "This terminal is a worker for another Orca's Run; its mail goes to that Run's coordinator, not to other servers. Nothing was sent.",
      NOTHING_SENT
    )
  }
  return { address: args.from, paneKey }
}

/** `send --on <server>`: this Orca carries the mail and keeps the conversation the replies come back on. */
export async function sendPeerMail(args: {
  params: z.infer<typeof SendParams> & { on: string }
  runtime: OrcaRuntimeService
  orchestrationCaller: OrchestrationSessionCaller | undefined
  attestedCaller: OrchestrationCompatibilityCallerAuthority | undefined
  orchestrationMutation: { callerFingerprint: string; requestId: string } | undefined
  recordMutationReceipt: ((receipt: unknown) => void) | undefined
}): Promise<unknown> {
  const { params, runtime } = args
  const to = params.to
  if (!to || /^(run|dispatch|task):/.test(to) || to.startsWith('@')) {
    throw new OrchestrationError(
      'invalid_argument',
      `--on sends to one terminal or chat agent on that server: --to term_… or --to orca_session_id:…${to ? `, not ${to}` : ''}. Nothing was sent.`,
      NOTHING_SENT
    )
  }
  const type = params.type ?? 'status'
  if (type !== 'status' && type !== 'handoff') {
    throw new OrchestrationError(
      'invalid_argument',
      `--on carries --type status or handoff, not ${type}. Nothing was sent.`,
      NOTHING_SENT
    )
  }
  if (params.payload !== undefined) {
    throw new OrchestrationError(
      'invalid_argument',
      '--on carries a subject and body; payload fields such as --task-id or --report-path name work on this Orca only. Nothing was sent.',
      NOTHING_SENT
    )
  }
  const caller = peerMailLocalCaller({ ...args, from: params.from })
  const server = await requirePeerMailServer(runtime, params.on)
  const conversation = runtime.getOrchestrationDb().openHomePeerMailConversation({
    environmentId: server.environmentId,
    peerFingerprint: peerMailPairing(server),
    localParty: caller.address,
    localPaneKey: caller.paneKey
  })
  const id = peerMailMessageId(args.orchestrationMutation)
  await deliverPeerMail(runtime, server, conversation, {
    id,
    to,
    senderLabel: peerMailSenderLabel(runtime, caller.address),
    subject: params.subject,
    body: params.body,
    type,
    priority: params.priority,
    threadId: params.threadId
  })
  return recordReceiptBeforeNudge(
    args.recordMutationReceipt,
    { message: { id, to }, server: server.name },
    () => runtime.ensureOrchestrationFederationRelay(),
    { kind: 'federation' }
  )
}

/** `orchestration.send` with `on` set goes to the paired server; every other send runs unchanged. */
export function withPeerMailSend(
  methods: typeof ORCHESTRATION_SEND_METHODS
): typeof ORCHESTRATION_SEND_METHODS {
  return methods.map((method) => ({
    ...method,
    handler: (params: Parameters<typeof method.handler>[0], ctx: RpcContext) => {
      const on = params.on
      if (on === undefined || ctx.replayedMutationReceipt !== undefined) {
        return method.handler(params, ctx)
      }
      const attested = ctx.orchestrationCompatibilityCallerAuthority
      return sendPeerMail({
        params: { ...params, on },
        runtime: ctx.runtime,
        orchestrationCaller: ctx.orchestrationCaller,
        attestedCaller: attested?.terminalHandle === params.from ? attested : undefined,
        orchestrationMutation: ctx.orchestrationMutation,
        recordMutationReceipt: ctx.recordMutationReceipt
      })
    }
  }))
}
