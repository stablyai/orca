import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { z } from 'zod'
import type { DeviceCredentialInstalled } from '../../../src/shared/mobile-relay-credential-contract'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import {
  MOBILE_HOST_ID_MAX_CHARACTERS,
  MobileHostIdSchema,
  PAIRING_DEVICE_TOKEN_MAX_CHARACTERS
} from './types'
import { parseMobileJsonTextWithinLimits } from './mobile-json-text-admission'

const Base64Url32ByteSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const MOBILE_RELAY_CREDENTIAL_BUNDLE_MAX_STORAGE_CHARACTERS = 128 * 1024
const ResumeCredentialSchema = z
  .object({
    token: Base64Url32ByteSchema,
    hash: Base64Url32ByteSchema,
    version: z.number().int().positive(),
    expiresAt: z.number().int().nonnegative()
  })
  .strict()

export const MobileRelayCredentialBundleSchema = z
  .object({
    v: z.literal(1),
    hostId: MobileHostIdSchema,
    deviceToken: z.string().min(1).max(PAIRING_DEVICE_TOKEN_MAX_CHARACTERS),
    current: ResumeCredentialSchema,
    grace: ResumeCredentialSchema.optional(),
    pending: z
      .object({
        token: Base64Url32ByteSchema,
        hash: Base64Url32ByteSchema,
        reqId: z.string().min(1).max(128)
      })
      .strict()
      .optional(),
    invite: z
      .object({ token: Base64Url32ByteSchema, expiresAt: z.number().int().positive() })
      .strict()
      .optional()
  })
  .strict()

export type MobileRelayCredentialBundle = z.infer<typeof MobileRelayCredentialBundleSchema>

const KEYCHAIN_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
}

function credentialKey(hostId: string): string {
  return `orca.mobile-relay.credentials.${hostId}`
}

export function promotePairingJournalCredential(args: {
  journal: MobileRelayPairingJournal
  installed: DeviceCredentialInstalled
}): MobileRelayCredentialBundle {
  const { journal, installed } = args
  if (
    installed.reqId !== journal.metadata.installReqId ||
    installed.authorizationMode !== journal.metadata.authorizationMode
  ) {
    throw new Error('relay credential install result does not match pairing journal')
  }
  return MobileRelayCredentialBundleSchema.parse({
    v: 1,
    hostId: journal.metadata.host.id,
    deviceToken: journal.secrets.deviceToken,
    current: {
      token: journal.secrets.pendingResumeToken,
      hash: journal.metadata.pendingResumeTokenHash,
      version: installed.currentVersion,
      expiresAt: installed.resumeExpiresAt
    }
  })
}

export async function readMobileRelayCredentialBundle(
  hostId: string
): Promise<MobileRelayCredentialBundle | null> {
  requireNativeSecretStore()
  if (!isValidHostId(hostId)) {
    return null
  }
  const raw = await SecureStore.getItemAsync(credentialKey(hostId), KEYCHAIN_OPTIONS)
  if (raw === null || raw.length > MOBILE_RELAY_CREDENTIAL_BUNDLE_MAX_STORAGE_CHARACTERS) {
    return null
  }
  try {
    const result = MobileRelayCredentialBundleSchema.safeParse(parseMobileJsonTextWithinLimits(raw))
    return result.success && result.data.hostId === hostId ? result.data : null
  } catch {
    return null
  }
}

export async function writeMobileRelayCredentialBundle(
  bundle: MobileRelayCredentialBundle
): Promise<void> {
  requireNativeSecretStore()
  const validated = MobileRelayCredentialBundleSchema.parse(bundle)
  const serialized = JSON.stringify(validated)
  if (serialized.length > MOBILE_RELAY_CREDENTIAL_BUNDLE_MAX_STORAGE_CHARACTERS) {
    throw new Error('mobile relay credential bundle exceeds storage limit')
  }
  await SecureStore.setItemAsync(credentialKey(validated.hostId), serialized, KEYCHAIN_OPTIONS)
}

export async function deleteMobileRelayCredentialBundle(hostId: string): Promise<void> {
  if (Platform.OS === 'web' || !isValidHostId(hostId)) {
    return
  }
  await SecureStore.deleteItemAsync(credentialKey(hostId), KEYCHAIN_OPTIONS)
}

function isValidHostId(hostId: string): boolean {
  return hostId.length > 0 && hostId.length <= MOBILE_HOST_ID_MAX_CHARACTERS
}

function requireNativeSecretStore(): void {
  if (Platform.OS === 'web') {
    throw new Error('Orca Relay credentials require a native secret store')
  }
}
