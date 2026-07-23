import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { z } from 'zod'
import { hashMobileRelayCredential } from './mobile-relay-credential-hash'
import { MOBILE_HOST_ID_MAX_CHARACTERS, MobileHostIdSchema } from './types'
import { parseMobileJsonTextWithinLimits } from './mobile-json-text-admission'

const Base64Url32ByteSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const MOBILE_RELAY_DIRECT_UPGRADE_MAX_STORAGE_CHARACTERS = 32 * 1024

export const MobileRelayDirectUpgradeJournalSchema = z
  .object({
    v: z.literal(1),
    hostId: MobileHostIdSchema,
    reqId: z.string().min(1).max(128),
    pendingResumeToken: Base64Url32ByteSchema,
    pendingResumeTokenHash: Base64Url32ByteSchema
  })
  .strict()

export type MobileRelayDirectUpgradeJournal = z.infer<typeof MobileRelayDirectUpgradeJournalSchema>

const KEYCHAIN_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
}

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
  if (!isValidHostId(hostId)) {
    return null
  }
  const raw = await SecureStore.getItemAsync(journalKey(hostId), KEYCHAIN_OPTIONS)
  if (!raw || raw.length > MOBILE_RELAY_DIRECT_UPGRADE_MAX_STORAGE_CHARACTERS) {
    return null
  }
  try {
    const parsed = MobileRelayDirectUpgradeJournalSchema.safeParse(
      parseMobileJsonTextWithinLimits(raw)
    )
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
  const serialized = JSON.stringify(parsed)
  if (serialized.length > MOBILE_RELAY_DIRECT_UPGRADE_MAX_STORAGE_CHARACTERS) {
    throw new Error('mobile relay direct-upgrade journal exceeds storage limit')
  }
  await SecureStore.setItemAsync(journalKey(parsed.hostId), serialized, KEYCHAIN_OPTIONS)
}

export async function deleteMobileRelayDirectUpgradeJournal(hostId: string): Promise<void> {
  if (Platform.OS === 'web' || !isValidHostId(hostId)) {
    return
  }
  await SecureStore.deleteItemAsync(journalKey(hostId), KEYCHAIN_OPTIONS)
}

function isValidHostId(hostId: string): boolean {
  return hostId.length > 0 && hostId.length <= MOBILE_HOST_ID_MAX_CHARACTERS
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
