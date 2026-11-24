// A teammate's message held in Orca Cloud while this host was away, delivered once it is back. The
// sealed box names its sender, but only this host's share device rows say who that is: the message
// then runs as that device's own calls (bots.session.start, uploads, agentSession.send), so the share
// allowlist, the chat guard and the share stamp are the live connection's, never a second copy.
import { z } from 'zod'
import type { Bot } from '../../../shared/bot-types'
import { botAccountShare } from '../../../shared/bots/bot-team-shares'
import {
  openBotTeamShareHeldMessage,
  type BotTeamShareHeldMessage
} from '../../../shared/bots/bot-team-share-seal'
import type {
  ConnectorDelivery,
  ConnectorDeliveryResult
} from '../../../shared/connectors/connector-cloud-contract'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import {
  agentSessionAttachmentAppends,
  base64DecodedByteLength
} from '../../../shared/agent-session/agent-session-attachments'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  structuredAgentSessionMessageSendMutation,
  structuredAgentSessionSendBody
} from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type {
  BotShareDevice,
  BotShareDeviceStore
} from '../../runtime/rpc/server/pairing/bot-share-device-store'

type ShareSend = Extract<ConnectorDelivery, { kind: 'share_send' }>

export type BotShareHeldMessageDeps = {
  /** This host's pairing E2EE keys, which the hello published as hostKey. */
  hostKeypair: { publicKeyB64: string; secretKey: Uint8Array } | null
  bots: { list: () => readonly Pick<Bot, 'id' | 'shares'>[] }
  devices: Pick<BotShareDeviceStore, 'list' | 'lookupDeviceKey'>
  /** One RPC call as the device, through the dispatcher as its socket's are; throws the call's error. */
  call: (device: BotShareDevice, method: string, params: unknown) => Promise<unknown>
  /** The chat's current runtime fence, as a client reads it before sending; null without a record. */
  fence: (sessionId: string) => number | null
}

// The replies this reads, as the handlers answer them.
const SessionReply = z.object({ sessionId: z.string().min(1) })
const ItemReply = z.object({ item: z.unknown() })
const UploadReply = z.object({ uploadId: z.string().min(1) })
const CommitReply = z.object({ path: z.string().min(1) })
const SendReply = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), refusal: z.object({ code: z.string() }) })
])

type DeviceCall = <T>(method: string, params: unknown, reply: z.ZodType<T>) => Promise<T>

const refused = (reason: string): ConnectorDeliveryResult => ({ outcome: 'refused', reason })
const ACCEPTED: ConnectorDeliveryResult = { outcome: 'accepted' }

/**
 * Accepted once the message is in the chat's journal (or already was); refused when this host's key
 * doesn't open it or its signature fails, its device key is no share device of that teammate on that
 * bot, or the share is gone. A thrown call settles refused with its reason, as other deliveries do.
 */
export async function deliverBotShareHeldMessage(
  deps: BotShareHeldMessageDeps,
  delivery: ShareSend
): Promise<ConnectorDeliveryResult> {
  if (!deps.hostKeypair) {
    return refused('host_key_unavailable')
  }
  const message = openBotTeamShareHeldMessage(NODE_PAIRED_E2EE_PRIMITIVES, {
    hostSecretKey: deps.hostKeypair.secretKey,
    hostKey: deps.hostKeypair.publicKeyB64,
    sealed: delivery.sealed,
    expect: delivery
  })
  if (!message) {
    return refused('bad_signature')
  }
  const bot = deps.bots.list().find((entry) => entry.id === delivery.botId)
  const share = botAccountShare(bot?.shares, delivery.shareId, delivery.accountId)
  if (!share) {
    return refused('unknown_share')
  }
  const device = shareDeviceOf(deps.devices, message, share.accountId)
  if (!device) {
    return refused('unknown_device')
  }
  const call: DeviceCall = async (method, params, reply) =>
    reply.parse(await deps.call(device, method, params))
  const sessionId =
    'sessionId' in message.chat
      ? message.chat.sessionId
      : // The same start a live New chat makes, so either one opens the chat the other finds.
        (
          await call(
            'bots.session.start',
            { botId: device.botId, newChatId: message.chat.newChatId },
            SessionReply
          )
        ).sessionId
  // Before any send: a redelivery, or the relay send it raced, already wrote it.
  const written = await call(
    'agentSession.item',
    { sessionId, itemId: agentJournalSubmissionKey(message.clientMessageId) },
    ItemReply
  )
  if (written.item) {
    return ACCEPTED
  }
  const fence = deps.fence(sessionId)
  if (fence === null) {
    return refused('session_not_found')
  }
  const attachments: { path: string; previewUri: string }[] = []
  for (const attachment of message.attachments) {
    attachments.push({ ...(await stageAttachment(call, sessionId, attachment)), previewUri: '' })
  }
  const sent = await call(
    'agentSession.send',
    structuredAgentSessionMessageSendMutation({
      sessionId,
      clientOperationId: message.clientMessageId,
      expectedRuntimeFence: fence,
      body: structuredAgentSessionSendBody(message.text, attachments)
    }),
    SendReply
  )
  return sent.ok ? ACCEPTED : refused(sent.refusal.code)
}

/** The teammate's own share device on this bot whose key signed it, while its row still stands. */
function shareDeviceOf(
  devices: BotShareHeldMessageDeps['devices'],
  message: BotTeamShareHeldMessage,
  accountId: string
): BotShareDevice | null {
  const row = devices
    .list()
    .find(
      (device) =>
        device.devicePublicKeyB64 === message.devicePublicKey &&
        device.botId === message.botId &&
        device.accountId === accountId
    )
  const lookup = row ? devices.lookupDeviceKey(row.deviceId) : null
  return lookup?.kind === 'found' ? lookup.device : null
}

/** Staged in the chat attachment store under the device's own caller key, as its live uploads are. */
async function stageAttachment(
  call: DeviceCall,
  sessionId: string,
  attachment: BotTeamShareHeldMessage['attachments'][number]
): Promise<{ path: string }> {
  const { uploadId } = await call(
    'agentSessionAttachment.uploadStart',
    {
      sessionId,
      name: attachment.name,
      byteLength: base64DecodedByteLength(attachment.contentBase64)
    },
    UploadReply
  )
  try {
    for (const chunk of agentSessionAttachmentAppends(attachment.contentBase64)) {
      await call('agentSessionAttachment.uploadAppend', { uploadId, ...chunk }, z.unknown())
    }
    const stored = await call('agentSessionAttachment.uploadCommit', { uploadId }, CommitReply)
    return { path: stored.path }
  } catch (error) {
    await call('agentSessionAttachment.uploadAbort', { uploadId }, z.unknown()).catch(() => {})
    throw error
  }
}
