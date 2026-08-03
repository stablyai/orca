import * as ExpoCrypto from 'expo-crypto'
import { sha256 } from '@noble/hashes/sha256'
import { z } from 'zod'
import type { PairingRelay } from '../../../src/shared/mobile-relay-pairing-offer'
import { hashMobileRelayCredential } from './mobile-relay-credential-hash'
import type { PairingOffer } from './types'

const Base64Url32ByteSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

export const MobileRelayPairingJournalMetadataSchema = z
  .object({
    v: z.literal(1),
    journalId: z.string().min(1).max(128),
    offerFingerprint: Base64Url32ByteSchema,
    host: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        endpoint: z.string().min(1),
        publicKeyB64: z.string().min(1),
        lastConnected: z.number().int().nonnegative()
      })
      .strict(),
    relay: z
      .object({
        v: z.literal(1),
        directorUrl: z.string().min(1),
        cellUrl: z.string().min(1),
        assignmentEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        relayHostId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
        inviteExpiresAt: z.number().int().positive(),
        e2eeFraming: z.literal(2)
      })
      .strict(),
    installReqId: z.string().min(1).max(128),
    resumeConfirmReqId: z.string().min(1).max(128),
    pendingResumeTokenHash: Base64Url32ByteSchema,
    winner: z.enum(['direct', 'relay']).optional(),
    authorizationMode: z.enum(['authenticated-direct', 'relay-basis']).optional()
  })
  .strict()

export const MobileRelayPairingJournalSecretsSchema = z
  .object({
    v: z.literal(1),
    journalId: z.string().min(1).max(128),
    deviceToken: z.string().min(1),
    inviteToken: Base64Url32ByteSchema,
    pendingResumeToken: Base64Url32ByteSchema
  })
  .strict()

export type MobileRelayPairingJournalMetadata = z.infer<
  typeof MobileRelayPairingJournalMetadataSchema
>
export type MobileRelayPairingJournalSecrets = z.infer<
  typeof MobileRelayPairingJournalSecretsSchema
>
export type MobileRelayPairingJournal = {
  metadata: MobileRelayPairingJournalMetadata
  secrets: MobileRelayPairingJournalSecrets
}

export function createMobileRelayPairingJournal(args: {
  offer: PairingOffer & { relay: PairingRelay }
  hostId: string
  hostName: string
  now?: number
  randomBytes?: (length: number) => Uint8Array
}): MobileRelayPairingJournal {
  const randomBytes = args.randomBytes ?? ExpoCrypto.getRandomBytes
  const pendingResumeToken = encodeBase64Url(randomBytes(32))
  const journalId = `pair-${encodeBase64Url(randomBytes(16))}`
  const installReqId = `install-${encodeBase64Url(randomBytes(16))}`
  const resumeConfirmReqId = `confirm-${encodeBase64Url(randomBytes(16))}`
  const { inviteToken, ...relayMetadata } = args.offer.relay
  return {
    metadata: MobileRelayPairingJournalMetadataSchema.parse({
      v: 1,
      journalId,
      offerFingerprint: encodeBase64Url(sha256(JSON.stringify(args.offer))),
      host: {
        id: args.hostId,
        name: args.hostName,
        endpoint: args.offer.endpoint,
        publicKeyB64: args.offer.publicKeyB64,
        lastConnected: args.now ?? Date.now()
      },
      relay: relayMetadata,
      installReqId,
      resumeConfirmReqId,
      pendingResumeTokenHash: hashMobileRelayCredential(pendingResumeToken)
    }),
    secrets: {
      v: 1,
      journalId,
      deviceToken: args.offer.deviceToken,
      inviteToken,
      pendingResumeToken
    }
  }
}

function encodeBase64Url(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
