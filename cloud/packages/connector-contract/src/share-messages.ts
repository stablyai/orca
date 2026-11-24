import { z } from 'zod'
import { CONNECTOR_LIMITS } from './connector-limits.js'

// A bot shared with Orca accounts: its host lists the people in its hello (sharedWith), and a
// teammate's Orca finds it with GET `${shares}/mine` and reaches the host over the relay. A message
// sent while the host is away is held here sealed to the host's key (held-message seal in the app),
// so the cloud sees who, which bot, when and how large, never the words. Every route and delivery
// here is used only with a cloud and a host that list CONNECTOR_CLOUD_BOT_SHARES_FEATURE.

// OpaqueIdSchema's shape, written here so the app imports this file as it is (no push-contract).
const OpaqueIdSchema = z.string().min(1).max(128)

/** The host's id for one person on a bot's share list, kept from invite to account. The host mints it
 *  random (a UUID or 16+ random bytes, base64url), so it is unique across hosts; it goes in paths as is. */
export const ShareIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

/** An email as a share stores and compares it: trimmed and lower case, wherever it came from. */
export function normalizeShareEmail(email: string): string {
  return email.trim().toLowerCase()
}

export const ShareEmailSchema = z
  .email()
  .max(CONNECTOR_LIMITS.maxShareEmailLength)
  .refine((email) => email === normalizeShareEmail(email))

// 32 bytes in canonical padded base64: the last character leaves the 2 spare bits zero.
export const CANONICAL_KEY_B64 = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/

// A 32-byte public key, standard padded base64 as pairing writes it: a device's Ed25519 key (its
// relay auth and held-message signatures) or a Curve25519 key things are sealed to.
export const SharePublicKeySchema = z.string().regex(CANONICAL_KEY_B64)

// SHA-256 of a phone's share credential, base64url, as the relay keeps a resume token's.
export const ShareCredentialHashSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

const Name = z.string().min(1).max(CONNECTOR_LIMITS.maxDisplayTextLength)

// One person a bot is shared with, in its hello: an Orca account, or an email not yet resolved to one.
export const ConnectorBotShareSchema = z.union([
  z.object({ shareId: ShareIdSchema, accountId: OpaqueIdSchema }),
  z.object({ shareId: ShareIdSchema, email: ShareEmailSchema })
])

// Deliveries to the host, all on the share's own conversation { source: 'orca', externalId: shareId },
// so the inbox hands them out in order: a resolve before an accept, an accept before a held message.
// The host acks each received: false and done once handled.
export const ShareDeliveryFields = {
  shareId: ShareIdSchema,
  botId: OpaqueIdSchema
}

// An invited email signed in to Orca: the host rewrites that invite as this account.
export const ShareResolvedFields = {
  ...ShareDeliveryFields,
  email: ShareEmailSchema,
  accountId: OpaqueIdSchema,
  name: Name.optional()
}

// A teammate's device asked to reach the bot: the host binds its Ed25519 key to the share, mints
// a relay offer and PUTs it, sealed to the device's Curve25519 sealKey, to
// `${bots}/<bot id>/shares/<share id>/offer`.
const DeviceAsk = {
  devicePublicKey: SharePublicKeySchema,
  sealKey: SharePublicKeySchema,
  deviceName: Name.optional()
}
export const ShareAcceptFields = {
  ...ShareDeliveryFields,
  accountId: OpaqueIdSchema,
  ...DeviceAsk
}

// A message the teammate sent while the host was away, sealed to the host's key. The host opens it,
// checks its signature against the share's device row and stamps the sender from that row.
export const ShareSendFields = {
  ...ShareDeliveryFields,
  accountId: OpaqueIdSchema,
  clientMessageId: OpaqueIdSchema,
  sealed: z.string().min(1).max(CONNECTOR_LIMITS.maxHeldMessageChars)
}

// PUT `${bots}/<bot id>/shares/<share id>/offer`: the accept's answer, for the teammate's next
// `${shares}/mine`. A repeat accept with the same key replaces it.
export const ConnectorShareOfferRequestSchema = z.object({
  v: z.literal(1),
  devicePublicKey: SharePublicKeySchema,
  sealedOffer: z.string().min(1).max(CONNECTOR_LIMITS.maxShareOfferChars)
})

// PUT `${bots}/<bot id>/shares/<share id>/devices/<device id>`: a teammate's phone's share
// credential, by hash, before the host gives the phone its grant; a repeat replaces the hash. DELETE
// the same path when the phone is removed. Only for a bot of the calling host and a share it lists.
export const ConnectorShareDeviceRequestSchema = z.object({
  v: z.literal(1),
  credentialHash: ShareCredentialHashSchema
})

// A held message, as its sender sees it: waiting for the host, delivered (in the host's journal), or
// not sent (the host refused it, it waited past requestWaitMs, or the share was removed).
export const SHARE_HELD_STATES = ['waiting', 'delivered', 'not_sent'] as const
export const ShareHeldMessageSchema = z.object({
  clientMessageId: OpaqueIdSchema,
  state: z.enum(SHARE_HELD_STATES)
})
// The caller's own held messages for a share, from the last requestWaitMs.
const Held = z.array(ShareHeldMessageSchema).max(CONNECTOR_LIMITS.maxShareHeldStates)

// GET `${shares}/mine` (connector token): the bots shared with the caller's account, or with its
// verified email (which also resolves the invite). needs-accept: no device of theirs reaches it yet.
export const ConnectorSharesMineSchema = z.object({
  v: z.literal(1),
  shares: z.array(
    z.object({
      shareId: ShareIdSchema,
      botId: OpaqueIdSchema,
      botName: Name,
      // The owner's hello ownerName, else their verified email, else the host's name: never empty.
      ownerName: Name,
      avatarUrl: z.string().url().max(2048).optional(),
      hostOnline: z.boolean(),
      state: z.enum(['ready', 'needs-accept']),
      // The host's E2EE key, which held messages are sealed to: present only once the host's hello
      // carries hostKey, which it sends when it takes share_send. Absent, the teammate's Orca holds
      // nothing and sends only while the host is online.
      hostKey: SharePublicKeySchema.optional(),
      // The host's answers to this account's accepts, by device key.
      offers: z
        .array(z.object({ devicePublicKey: SharePublicKeySchema, sealedOffer: z.string().min(1) }))
        .optional(),
      held: Held
    })
  )
})

// POST `${shares}/<share id>/accept` (connector token): queues share_accept. Idempotent per
// (share, device key): a repeat, as after the relay invite expired, has the host mint a fresh one.
// Answers 202 queued; the offer comes later on `${shares}/mine`.
export const ConnectorShareAcceptRequestSchema = z.object({ v: z.literal(1), ...DeviceAsk })
export const ConnectorShareAcceptSchema = z.object({ status: z.literal('queued') })

// POST `${shares}/<share id>/messages`, with the connector token (desktop) or
// `Bearer <share credential>` (phone): holds one message for the host. duplicate: that
// clientMessageId was already held.
export const ConnectorShareHoldRequestSchema = z.object({
  v: z.literal(1),
  clientMessageId: OpaqueIdSchema,
  sealed: z.string().min(1).max(CONNECTOR_LIMITS.maxHeldMessageChars)
})
export const ConnectorShareHoldSchema = z.object({ status: z.enum(['held', 'duplicate']) })

// GET `${shares}/<share id>/messages` (phone, `Bearer <share credential>`): that share's held states.
export const ConnectorShareHeldSchema = z.object({ v: z.literal(1), held: Held })

// Refusals on the shares routes: the share isn't the caller's (or is gone), or its host's hello
// doesn't list bots.shares.
export const CONNECTOR_SHARE_ERRORS = ['unknown_share', 'host_not_sharing'] as const

export type ConnectorBotShare = z.infer<typeof ConnectorBotShareSchema>
export type ConnectorShareOfferRequest = z.infer<typeof ConnectorShareOfferRequestSchema>
export type ConnectorShareDeviceRequest = z.infer<typeof ConnectorShareDeviceRequestSchema>
export type ShareHeldMessage = z.infer<typeof ShareHeldMessageSchema>
export type ConnectorSharesMine = z.infer<typeof ConnectorSharesMineSchema>
export type ConnectorShareAcceptRequest = z.infer<typeof ConnectorShareAcceptRequestSchema>
export type ConnectorShareAccept = z.infer<typeof ConnectorShareAcceptSchema>
export type ConnectorShareHoldRequest = z.infer<typeof ConnectorShareHoldRequestSchema>
export type ConnectorShareHold = z.infer<typeof ConnectorShareHoldSchema>
export type ConnectorShareHeld = z.infer<typeof ConnectorShareHeldSchema>
export type ConnectorShareError = (typeof CONNECTOR_SHARE_ERRORS)[number]
