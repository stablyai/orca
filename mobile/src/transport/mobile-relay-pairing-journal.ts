import * as ExpoCrypto from 'expo-crypto'
import { sha256 } from '@noble/hashes/sha256'
import { z } from 'zod'
import {
  PAIRING_RELAY_URL_MAX_CHARACTERS,
  type PairingRelay
} from '../../../src/shared/mobile-relay-pairing-offer'
import { hashMobileRelayCredential } from './mobile-relay-credential-hash'
import {
  MOBILE_HOST_ID_MAX_CHARACTERS,
  MOBILE_HOST_NAME_MAX_CHARACTERS,
  PAIRING_DEVICE_TOKEN_MAX_CHARACTERS,
  PAIRING_ENDPOINT_MAX_CHARACTERS,
  PAIRING_PUBLIC_KEY_MAX_CHARACTERS,
  type PairingOffer
} from './types'

const Base64Url32ByteSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const MOBILE_RELAY_PAIRING_METADATA_MAX_STORAGE_CHARACTERS = 256 * 1024
export const MOBILE_RELAY_PAIRING_SECRETS_MAX_STORAGE_CHARACTERS = 128 * 1024

export const MobileRelayPairingJournalMetadataSchema = z
  .object({
    v: z.literal(1),
    journalId: z.string().min(1).max(128),
    offerFingerprint: Base64Url32ByteSchema,
    host: z
      .object({
        id: z.string().min(1).max(MOBILE_HOST_ID_MAX_CHARACTERS),
        name: z.string().min(1).max(MOBILE_HOST_NAME_MAX_CHARACTERS),
        endpoint: z.string().min(1).max(PAIRING_ENDPOINT_MAX_CHARACTERS),
        publicKeyB64: z.string().min(1).max(PAIRING_PUBLIC_KEY_MAX_CHARACTERS),
        lastConnected: z.number().int().nonnegative()
      })
      .strict(),
    relay: z
      .object({
        v: z.literal(1),
        directorUrl: z.string().min(1).max(PAIRING_RELAY_URL_MAX_CHARACTERS),
        cellUrl: z.string().min(1).max(PAIRING_RELAY_URL_MAX_CHARACTERS),
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
    deviceToken: z.string().min(1).max(PAIRING_DEVICE_TOKEN_MAX_CHARACTERS),
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
