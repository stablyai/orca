// A teammate's message to a shared agent whose host can't be reached: sealed to the host's key and
// signed by this device, then held in Orca Cloud until the host is back.
import type { ConnectorFailure } from '../../connector-cloud/connector-cloud-request'
import nacl from 'tweetnacl'
import { MAX_HELD_MESSAGE_CHARS } from '../../../shared/connector-share-contract'
import { sealBotTeamShareHeldMessage } from '../../../shared/bots/bot-team-share-seal'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import type { SharedBotHeldMessage, SharedBotHostEntry } from './shared-bot-host-store'
import type { SharedBotsCloud } from './shared-bots-cloud'

export type HandOffResult =
  | { kind: 'held'; held: SharedBotHeldMessage }
  // Past the cloud's 1 MiB for one held message, attachments included.
  | { kind: 'too-large' }
  | { kind: 'failed'; failure: Pick<ConnectorFailure, 'status' | 'error'> }

/** Holds one message for `entry`'s host, sealed to `hostKey` (see `sharedBotHostKey`). */
export async function handOffSharedBotMessage(
  cloud: SharedBotsCloud,
  entry: SharedBotHostEntry,
  hostKey: string,
  message: {
    chat: SharedBotHeldMessage['chat']
    clientMessageId: string
    text: string
    attachments: readonly { name: string; contentBase64: string }[]
    sentAt: number
  }
): Promise<HandOffResult> {
  const secretKey = Buffer.from(entry.deviceKey.secretKeyB64, 'base64')
  const { text, attachments } = message
  const sealed = await sealBotTeamShareHeldMessage(NODE_PAIRED_E2EE_PRIMITIVES, {
    hostKey,
    message: {
      v: 1,
      shareId: entry.shareId,
      botId: entry.botId,
      chat: message.chat,
      clientMessageId: message.clientMessageId,
      text,
      attachments: [...attachments],
      sentAt: message.sentAt,
      devicePublicKey: entry.deviceKey.publicKeyB64
    },
    sign: async (bytes) => nacl.sign.detached(bytes, secretKey)
  })
  if (sealed.length > MAX_HELD_MESSAGE_CHARS) {
    return { kind: 'too-large' }
  }
  const answer = await cloud.hold(entry.shareId, {
    v: 1,
    clientMessageId: message.clientMessageId,
    sealed
  })
  if (!answer.ok) {
    return { kind: 'failed', failure: { status: answer.status, error: answer.error } }
  }
  return {
    kind: 'held',
    held: {
      clientMessageId: message.clientMessageId,
      chat: message.chat,
      text,
      ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
      sentAt: message.sentAt
    }
  }
}
