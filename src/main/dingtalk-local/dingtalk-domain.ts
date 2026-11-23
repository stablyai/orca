import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import * as z from 'zod'

const Profile = z
  .string()
  .regex(/^[^:,\s]+:[^:,\s]+$/)
  .brand<'DingTalkProfile'>()
const GroupId = z.string().min(1).max(256).brand<'DingTalkGroupId'>()
const MessageId = z.string().min(1).max(512).brand<'DingTalkMessageId'>()
const ConversationId = z.string().min(1).max(512).brand<'DingTalkConversationId'>()
const ExternalId = z
  .string()
  .regex(/^dt1_[A-Za-z0-9_-]{16,256}$/)
  .brand<'DingTalkExternalId'>()
const DeliveryId = z
  .string()
  .regex(/^dtd1_[A-Za-z0-9_-]{16,256}$/)
  .brand<'DingTalkDeliveryId'>()
const ReplyId = z
  .string()
  .regex(/^dtr1_[A-Za-z0-9_-]{16,256}$/)
  .brand<'DingTalkReplyId'>()

export type DingTalkProfile = z.infer<typeof Profile>
export type DingTalkGroupId = z.infer<typeof GroupId>
export type DingTalkMessageId = z.infer<typeof MessageId>
export type DingTalkConversationId = z.infer<typeof ConversationId>
export type DingTalkExternalId = z.infer<typeof ExternalId>
export type DingTalkDeliveryId = z.infer<typeof DeliveryId>
export type DingTalkReplyId = z.infer<typeof ReplyId>

export const DingTalkMode = z.enum(['at', 'all'])
const GroupSetup = z.object({
  profile: Profile,
  groupId: GroupId,
  botId: z.string().min(1).max(128),
  mode: DingTalkMode.default('at'),
  prefix: z.string().max(64).default('/tsbot'),
  requirePrefix: z.boolean().default(true),
  selfNames: z.array(z.string().min(1).max(80)).max(10).default([]),
  selfOpenId: z.string().max(256).default(''),
  noiseFilter: z.boolean().default(true)
})
const Setup = z.object({
  enabled: z.boolean().default(false),
  dwsPath: z.string().min(1).default('dws'),
  autoReply: z.boolean().default(false),
  groups: z.array(GroupSetup).max(200).default([])
})

export type DingTalkGroupSetup = z.infer<typeof GroupSetup>
export type DingTalkSetup = z.infer<typeof Setup>

export type DingTalkInbound = {
  profile: DingTalkProfile
  source: 'at' | 'group'
  groupId: DingTalkGroupId
  conversationId: DingTalkConversationId
  messageId: DingTalkMessageId
  senderOpenId: string
  senderName: string
  content: string
  createTime: string
}

export type InboxState =
  | 'pending'
  | 'delivering'
  | 'delivered'
  | 'attributed'
  | 'filtered'
  | 'failed'
export type ReplyState = 'queued' | 'sending' | 'sent' | 'uncertain' | 'failed'

export type InboxRow = {
  key: string
  event: DingTalkInbound
  externalId: DingTalkExternalId
  body: string
  state: InboxState
  deliveryId: DingTalkDeliveryId
  reason: string
  updatedAt: number
}

export type ConversationRow = {
  externalId: DingTalkExternalId
  profile: DingTalkProfile
  groupId: DingTalkGroupId
  conversationId: DingTalkConversationId
  botId: string
  sessionId: string
  latestMessageId: DingTalkMessageId
  updatedAt: number
}

export type ReplyRow = {
  key: DingTalkReplyId
  externalId: DingTalkExternalId
  profile: DingTalkProfile
  groupId: DingTalkGroupId
  text: string
  uuid: string
  turnId: number
  state: ReplyState
  error: string
  updatedAt: number
}

export type DingTalkLedgerState = {
  version: 1
  inbox: Record<string, InboxRow>
  conversations: Record<string, ConversationRow>
  replies: Record<string, ReplyRow>
  watermarks: Record<string, string>
}

export function parseDingTalkSetup(raw: unknown, botIds: readonly string[] = []): DingTalkSetup {
  const setup = Setup.parse(raw)
  const known = new Set(botIds)
  for (const group of setup.groups) {
    if (known.size > 0 && !known.has(group.botId)) {
      throw new Error(`unknown DingTalk bot ${group.botId}`)
    }
    if (group.mode === 'all' && group.requirePrefix) {
      throw new Error(`group ${group.groupId} in all mode must disable requirePrefix`)
    }
  }
  const bindings = new Set<string>()
  for (const group of setup.groups) {
    const key = `${group.profile}\u0000${group.groupId}`
    if (bindings.has(key)) {
      throw new Error(`duplicate DingTalk group binding ${group.groupId}`)
    }
    bindings.add(key)
  }
  return setup
}

/** A missing file means the connector is off. */
export async function readDingTalkSetup(
  path: string,
  botIds: readonly string[] = []
): Promise<DingTalkSetup> {
  const text = await readFile(path, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  const raw: unknown = text === null ? { enabled: false } : JSON.parse(text)
  return parseDingTalkSetup(raw, botIds)
}

function stable<T extends string>(
  prefix: string,
  parts: readonly string[],
  parse: (value: string) => T
): T {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('base64url')
  return parse(`${prefix}${digest.slice(0, 43)}`)
}

export function stableExternalId(
  profile: DingTalkProfile,
  conversationId: DingTalkConversationId
): DingTalkExternalId {
  return stable('dt1_', [profile, conversationId], ExternalId.parse)
}

export function stableDeliveryId(
  profile: DingTalkProfile,
  messageId: DingTalkMessageId
): DingTalkDeliveryId {
  return stable('dtd1_', [profile, messageId], DeliveryId.parse)
}

export function stableReplyId(externalId: DingTalkExternalId, turnId: number): DingTalkReplyId {
  return stable('dtr1_', [externalId, String(turnId)], ReplyId.parse)
}

export function stableSendUuid(replyId: DingTalkReplyId): string {
  return `dt-local-${createHash('sha256').update(replyId).digest('hex').slice(0, 40)}`
}

export const schemas = {
  Profile,
  GroupId,
  MessageId,
  ConversationId,
  ExternalId,
  DeliveryId,
  ReplyId
}
