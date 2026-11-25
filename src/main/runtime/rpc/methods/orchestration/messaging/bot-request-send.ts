/** Stores mail to a bot with Orca's record of the request beside it, after the checks pass. */

import { isBotGroupMemberSession } from '../../../../../../shared/bots/bot-group'
import { runtimeBotGroups } from '../../../../../bots/bot-group-runtime'
import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import { runtimeBotChats } from '../../../../../bots/bot-chat-session'
import {
  failureHeldChat,
  heldChatSentNext,
  type HeldChat
} from '../../../../../bots/bot-held-chat-request'
import { admitInNewChat, sessionAddress } from './bot-request-conversation'
import { ownerChatCard } from './bot-request-owner-card'
import { botRequestPayload, type BotRequestRecord } from '../../../../../bots/bot-request-view'
import type { BotRequestAdmission } from '../../../../orchestration/db/bot-requests/bot-request-store'
import {
  BOT_REQUEST_TYPE_REFUSAL,
  botNotFound,
  botRequestRefusal,
  isBotRequestPurpose
} from '../../../../../bots/bot-request-policy'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { generateId } from '../../../../orchestration/db/generated-id'
import type { OrchestrationPartyIdentity as OrchestrationCallerIdentity } from '../../../../../../shared/orchestration/mailbox/orchestration-party-identity'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { RunRow } from '../../../../orchestration/db/orchestration-records'
import type { RpcContext } from '../../../core'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { SendParams } from './send-params'
import {
  botAddressReach,
  readActingSender,
  receivingBot,
  refuse,
  toOtherChat,
  type ActingSender,
  type ReceivingBot
} from './bot-recipient'
import { exposeMessage } from './mailbox-message-receipt'
import { recordReceiptForPostCommitNudge } from './mutation-replay-nudge'
import { botRequestChain, botRequestSendKey } from './bot-request-chain'
import { answersRequest, askedInConversation, botRequestSender } from './bot-request-record'
import type { PairedSender } from '../../../../../../shared/orchestration/mailbox/paired-sender-name'
import { resolveBareOrchestrationRecipient } from './recipient-routing'
import { sessionCallerOf } from '../../../../orchestration/addressing/orchestration-caller-identity'

type SendParamsInput = Pick<
  z.infer<typeof SendParams>,
  'subject' | 'body' | 'type' | 'priority' | 'threadId'
>

/** Whether an address could reach a bot; decided without waiting, so other mail is stored as before. */
export function mayReachBot(
  runtime: OrcaRuntimeService,
  to: string,
  sender: OrchestrationCallerIdentity
): boolean {
  return botAddressReach(runtime, runtime.getOrchestrationDb(), to, sender).kind !== 'none'
}

/** Mail that reaches a bot, by any address, is held to who the sending turn is for; null for other mail. */
export async function sendToBot(
  context: Pick<RpcContext, 'runtime' | 'orchestrationCaller' | 'recordMutationReceipt'>,
  mail: {
    params: SendParamsInput
    from: string
    to: string
    sender: OrchestrationCallerIdentity
    routing: { run: RunRow | undefined }
    /** `--chat new`: the request opens a new chat on the receiving bot. */
    newChat?: boolean
    /** Chosen by the sender (an item made for another bot), so it can find the mail it sent. */
    messageId?: string
    /** The recipient isn't woken until the caller runs `nudge`: an item it names is made first. */
    holdNudge?: boolean
  } & Pick<SendBotRequestArgs, 'senderSnapshot' | 'pairedSender' | 'images' | 'onAdmitted'>
): Promise<{ receipt: unknown; nudge: () => void } | null> {
  const { runtime } = context
  const db = runtime.getOrchestrationDb()
  const senderRunId = mail.routing.run?.id
  const reach = botAddressReach(runtime, db, mail.to, mail.sender)
  const found = await receivingBot(runtime, reach, mail.to)
  if (!found) {
    return null
  }
  const receiving = mail.newChat ? { ...found, newChat: true } : found
  const callerSessionId = sessionCallerOf(context.orchestrationCaller)?.sessionId
  if (mail.to.includes('bot-group-member-') && !isBotGroupMemberSession(callerSessionId)) {
    throw new Error(
      'Group bot sessions accept peer requests only from current members of their own group.'
    )
  }
  const acting = await readActingSender(runtime, db, callerSessionId, mail.sender, receiving)
  if (!acting) {
    return null
  }
  const held: (() => void)[] = []
  const receipt = await sendBotRequest({
    runtime,
    db,
    ...mail,
    receiving,
    acting,
    senderRunId,
    senderPaneKey: mail.sender.paneKey ?? undefined,
    recordMutationReceipt: context.recordMutationReceipt,
    ...(mail.holdNudge ? { held } : {})
  })
  return { receipt, nudge: () => held.splice(0).forEach((nudge) => nudge()) }
}

type SendBotRequestArgs = {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  params: SendParamsInput
  from: string
  to: string
  receiving: ReceivingBot
  acting: ActingSender
  senderRunId: string | undefined
  senderPaneKey: string | undefined
  recordMutationReceipt: ((receipt: unknown) => void) | undefined
  messageId?: string
  /** Who sent it as the card shows them, for a sender this Orca has no record of (another computer's). */
  senderSnapshot?: string
  /** Its sender is an agent on a computer paired with this one, either side of the pairing. */
  pairedSender?: PairedSender
  /** Store images claimed for the receiving chat (`send --item --file`). */
  images?: readonly string[]
  /** Nudges the sender runs later instead of now. */
  held?: (() => void)[]
  /** Commits with the request's admission, before anyone is woken for it. */
  onAdmitted?: () => void
}

/** Every refusal, from the first check to a blocked admission, leaves the owner's card. */
async function sendBotRequest(args: SendBotRequestArgs): Promise<unknown> {
  const asked = askedInConversation(args.runtime, args.acting)
  const card = ownerChatCard(args.acting, args.receiving, args.params, asked)
  try {
    return await admitBotRequestMail(args, card, asked)
  } catch (error) {
    card.refused(error)
    throw error
  }
}

async function admitBotRequestMail(
  args: SendBotRequestArgs,
  card: ReturnType<typeof ownerChatCard>,
  asked: Pick<BotRequestRecord, 'askedInConversation'>
): Promise<unknown> {
  const { runtime, db, params, receiving, acting } = args
  const chain = botRequestChain(db, acting.sessionId, acting.turn)
  /** Checked now and again just before storing, after every wait, against the bot as it is then. */
  const check = () => {
    const bot = runtime.bots.list().find((entry) => entry.id === receiving.bot.id)
    const refusal = bot
      ? botRequestRefusal({
          enabled: runtime.bots.enabled(),
          target: bot,
          senderBotId: acting.bot?.id ?? null,
          toOtherChat: toOtherChat(receiving, acting.sessionId),
          type: params.type,
          fromWorker: acting.worker !== undefined
        })
      : botNotFound(receiving.bot.name, runtime.bots.list())
    if (refusal || !bot || !isBotRequestPurpose(params.type)) {
      return refuse(refusal ?? BOT_REQUEST_TYPE_REFUSAL)
    }
    return { bot, purpose: params.type }
  }
  const { bot: target, purpose } = check()
  const groupScope = isBotGroupMemberSession(acting.sessionId)
    ? await runtimeBotGroups(runtime).peerScope(acting.sessionId, target.id, acting.turn.rootItemId)
    : null
  if (groupScope && receiving.newChat) {
    throw new OrchestrationError(
      'invalid_argument',
      "A group's bots answer in the group's own chats, so send it again without --chat new."
    )
  }
  const record: BotRequestRecord = {
    ...(groupScope
      ? {
          group: {
            id: groupScope.group.id,
            rootRequestId: groupScope.rootRequestId,
            rootSequence: groupScope.rootSequence,
            sourceSessionId: groupScope.source.sessionId,
            targetSessionId: groupScope.target.sessionId
          }
        }
      : {}),
    ...botRequestSender(acting.bot, args.pairedSender),
    ...(acting.worker ? { fromWorker: true } : {}),
    toBotId: target.id,
    toBotName: target.name,
    purpose,
    depth: chain.depth,
    askers: acting.turn.askers,
    askedBy: acting.turn.askedBy,
    request: groupScope?.originalHumanInstruction ?? acting.turn.request,
    conversation: acting.conversation,
    ...(acting.triggeredBy ? { triggeredBy: acting.triggeredBy } : {}),
    ...(acting.turn.origin ? { origin: acting.turn.origin } : {}),
    ...(acting.turn.originPlace ? { originPlace: acting.turn.originPlace } : {}),
    ...asked,
    ...answersRequest(db, acting)
  }
  // A worker's send is its own: another worker asking the same still gets an answer.
  const sendTurn = acting.worker ? `dispatch:${acting.worker}` : chain.turnKey
  const key = {
    rootKey: chain.rootKey ?? `send:${randomUUID()}`,
    // Only this same send again is a duplicate; a new request to a bot the chain reached is delivered.
    ...(sendTurn ? { sendKey: botRequestSendKey(sendTurn, target.id, purpose, params) } : {}),
    toBotId: target.id,
    purpose
  }
  const blockedReceipt = (
    blocked: Exclude<BotRequestAdmission, { kind: 'sent' }>
  ): { sent: false; receipt: unknown } => {
    const earlier = db.getMessageById(blocked.messageId)
    return {
      sent: false,
      receipt: {
        ...(earlier ? { message: exposeMessage(earlier) } : {}),
        duplicate: true,
        next: `${target.name} already has this request, so no second message was sent.`
      }
    }
  }
  const messageId = args.messageId ?? generateId('msg')
  // Checked before a conversation is made for it; the store checks again as it stores.
  const blocked = db.botRequestBlocked(key)
  if (blocked) {
    return blockedReceipt(blocked).receipt
  }
  // The whole payload is Orca's, so the receiving bot never reads the sender's own fields as these.
  const payload = botRequestPayload(record, messageId, args.images)
  const request = {
    ...key,
    fromBotId: record.fromBotId,
    depth: record.depth,
    record: JSON.stringify(record)
  }
  /** `reserved`: the request's place is already held, so only its mail is stored. */
  /** `held`: the chat a failed turn holds that this request queues in, named to the sender. */
  const admit = (address: string, reserved = false, held?: HeldChat | null) => {
    const recipient =
      address.startsWith('run:') && receiving.via === 'address'
        ? { ok: true as const, to: address, runId: address.slice('run:'.length) }
        : resolveBareOrchestrationRecipient({
            runtime,
            db,
            handle: address,
            senderRunId: args.senderRunId
          })
    if (!recipient.ok) {
      throw new OrchestrationError(recipient.code, recipient.message)
    }
    // The bot may have been paused or removed while the Chat was found.
    check()
    runtimeBotGroups(runtime).assertPeerScope(groupScope)
    const mail = {
      id: messageId,
      from: args.from,
      to: recipient.to,
      subject: params.subject,
      body: params.body,
      type: purpose,
      priority: params.priority,
      threadId: params.threadId,
      payload,
      orcaAuthored: 'bot-request' as const,
      senderPaneKey: args.senderPaneKey,
      runId: recipient.runId,
      answerSenderSnapshot: args.senderSnapshot
    }
    const admission: BotRequestAdmission = reserved
      ? { kind: 'sent', message: db.admitReservedBotRequest(mail, args.onAdmitted) }
      : db.admitBotRequest({ ...request, message: mail, onAdmitted: args.onAdmitted })
    if (admission.kind !== 'sent') {
      return blockedReceipt(admission)
    }
    const { message } = admission
    runtimeBotGroups(runtime).noteMailed(groupScope?.operationId, target.id)
    card.write({ messageId: message.id })
    const sent = recordReceiptForPostCommitNudge(
      args.recordMutationReceipt,
      { message: exposeMessage(message), next: heldChatSentNext(record, held) },
      () => runtime.notifyMessageArrived(message.to_handle, message.type)
    )
    if (args.held) {
      args.held.push(sent.nudge)
    } else {
      sent.nudge()
    }
    return { sent: true, receipt: sent.receipt }
  }
  /** `--chat new`: the request opens a chat the bot starts for it, shown in its tab bar. */
  const inNewChat = () => {
    // Held before the chat is made, so a competing send makes none.
    const reservation = db.reserveBotRequest({ ...request, messageId })
    if (reservation.kind !== 'reserved') {
      return Promise.resolve(blockedReceipt(reservation).receipt)
    }
    return admitInNewChat(runtime, target, record, params.subject, {
      admit: (address) => admit(address, true),
      release: () => db.releaseBotRequest(messageId)
    })
  }
  if (groupScope) {
    return admit(sessionAddress(groupScope.target.sessionId)).receipt
  }
  // Whoever the sending turn acts for, the request lands where it was addressed; its record says who asked.
  if (receiving.newChat) {
    return inNewChat()
  }
  // A chat whose last turn failed queues it like its owner's own follow-ups; the sender is told.
  if (receiving.via === 'address') {
    const home = receiving.chat !== null && receiving.chat === target.chatSessionId
    return admit(args.to, false, await failureHeldChat(runtime, receiving.chat, home)).receipt
  }
  // Held through the store, so a new Chat can't retire this one between choosing it and mailing it.
  return runtimeBotChats(runtime).withChat(target.id, async (sessionId) => {
    const held = await failureHeldChat(runtime, sessionId, true)
    return admit(sessionAddress(sessionId), false, held).receipt
  })
}
