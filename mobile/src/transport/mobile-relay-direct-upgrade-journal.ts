import { Platform } from 'react-native'
import { z } from 'zod'
import { hashMobileRelayCredential } from './mobile-relay-credential-hash'
import {
  deletePairingKeychainItem,
  readPairingKeychainItem,
  writePairingKeychainItem
} from './pairing-keychain'
import { markHostCredentialWrite } from './host-credential-write-revision'

const Base64Url32ByteSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

export const MobileRelayDirectUpgradeJournalSchema = z
  .object({
    v: z.literal(1),
    hostId: z.string().min(1),
    reqId: z.string().min(1).max(128),
    pendingResumeToken: Base64Url32ByteSchema,
    pendingResumeTokenHash: Base64Url32ByteSchema
  })
  .strict()

export type MobileRelayDirectUpgradeJournal = z.infer<typeof MobileRelayDirectUpgradeJournalSchema>

function journalKey(hostId: string): string {
  return `orca.mobile-relay.direct-upgrade.${hostId}`
}

export function createMobileRelayDirectUpgradeJournal(
  hostId: string,
  randomBytes: (length: number) => Uint8Array
): MobileRelayDirectUpgradeJournal {
  const pendingResumeToken = encodeBase64Url(randomBytes(32))
  return MobileRelayDirectUpgradeJournalSchema.parse({
    v: 1,
    hostId,
    reqId: `upgrade-${encodeBase64Url(randomBytes(16))}`,
    pendingResumeToken,
    pendingResumeTokenHash: hashMobileRelayCredential(pendingResumeToken)
  })
}

export async function readMobileRelayDirectUpgradeJournal(
  hostId: string
): Promise<MobileRelayDirectUpgradeJournal | null> {
  requireNativeSecretStore()
  const raw = await readPairingKeychainItem(journalKey(hostId))
  if (!raw) {
    return null
  }
  try {
    const parsed = MobileRelayDirectUpgradeJournalSchema.safeParse(JSON.parse(raw))
    return parsed.success && parsed.data.hostId === hostId ? parsed.data : null
  } catch {
    return null
  }
}

export async function writeMobileRelayDirectUpgradeJournal(
  journal: MobileRelayDirectUpgradeJournal
): Promise<void> {
  requireNativeSecretStore()
  const parsed = MobileRelayDirectUpgradeJournalSchema.parse(journal)
  markHostCredentialWrite(parsed.hostId)
  await writePairingKeychainItem(journalKey(parsed.hostId), JSON.stringify(parsed))
}

export async function deleteMobileRelayDirectUpgradeJournal(hostId: string): Promise<void> {
  if (Platform.OS === 'web') {
    return
  }
  await deletePairingKeychainItem(journalKey(hostId))
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function requireNativeSecretStore(): void {
  if (Platform.OS === 'web') {
    throw new Error('Orca Relay upgrade state requires a native secret store')
  }
}
