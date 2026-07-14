import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import {
  MobileRelayPairingJournalMetadataSchema,
  MobileRelayPairingJournalSecretsSchema,
  type MobileRelayPairingJournal,
  type MobileRelayPairingJournalMetadata
} from './mobile-relay-pairing-journal'

const JOURNAL_STORAGE_KEY = 'orca:mobile-relay:pairing-journal:v1'
const JOURNAL_SECRET_KEY = 'orca.mobile-relay.pairing-journal.v1'
const KEYCHAIN_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
}
let journalMutation: Promise<void> = Promise.resolve()

export async function saveMobileRelayPairingJournal(
  journal: MobileRelayPairingJournal
): Promise<void> {
  requireNativeSecretStore()
  const metadata = MobileRelayPairingJournalMetadataSchema.parse(journal.metadata)
  const secrets = MobileRelayPairingJournalSecretsSchema.parse(journal.secrets)
  if (metadata.journalId !== secrets.journalId) {
    throw new Error('mobile relay pairing journal identity mismatch')
  }
  const mutation = journalMutation.then(async () => {
    const existingRaw = await AsyncStorage.getItem(JOURNAL_STORAGE_KEY)
    const existing = existingRaw ? parseMetadata(existingRaw) : null
    if (existing && existing.journalId !== metadata.journalId) {
      throw new Error('mobile relay pairing recovery pending')
    }
    // Why: metadata-first makes a crash before the keychain write recover as
    // an incomplete journal, never as an untracked bearer secret.
    await AsyncStorage.setItem(JOURNAL_STORAGE_KEY, JSON.stringify(metadata))
    await SecureStore.setItemAsync(JOURNAL_SECRET_KEY, JSON.stringify(secrets), KEYCHAIN_OPTIONS)
  })
  journalMutation = mutation.catch(() => {})
  return mutation
}

export async function loadMobileRelayPairingJournal(): Promise<MobileRelayPairingJournal | null> {
  requireNativeSecretStore()
  await journalMutation
  const rawMetadata = await AsyncStorage.getItem(JOURNAL_STORAGE_KEY)
  if (rawMetadata === null) {
    await SecureStore.deleteItemAsync(JOURNAL_SECRET_KEY, KEYCHAIN_OPTIONS).catch(() => {})
    return null
  }
  const metadata = parseMetadata(rawMetadata)
  if (!metadata) {
    await removeIncompleteJournal()
    return null
  }
  const rawSecrets = await SecureStore.getItemAsync(JOURNAL_SECRET_KEY, KEYCHAIN_OPTIONS)
  if (rawSecrets === null) {
    await AsyncStorage.removeItem(JOURNAL_STORAGE_KEY)
    return null
  }
  const secrets = parseSecrets(rawSecrets)
  if (!secrets || secrets.journalId !== metadata.journalId) {
    await removeIncompleteJournal()
    return null
  }
  return { metadata, secrets }
}

async function removeIncompleteJournal(): Promise<void> {
  // Why: metadata is the discoverable cleanup pointer; remove it before the
  // native secret so a second crash can only leave a self-cleaning orphan.
  await AsyncStorage.removeItem(JOURNAL_STORAGE_KEY)
  await SecureStore.deleteItemAsync(JOURNAL_SECRET_KEY, KEYCHAIN_OPTIONS).catch(() => {})
}

export async function updateMobileRelayPairingJournal(
  journalId: string,
  update: (metadata: MobileRelayPairingJournalMetadata) => MobileRelayPairingJournalMetadata
): Promise<void> {
  const mutation = journalMutation.then(async () => {
    const raw = await AsyncStorage.getItem(JOURNAL_STORAGE_KEY)
    const current = raw ? parseMetadata(raw) : null
    if (!current || current.journalId !== journalId) {
      throw new Error('stale mobile relay pairing journal')
    }
    const next = MobileRelayPairingJournalMetadataSchema.parse(update(current))
    if (next.journalId !== journalId) {
      throw new Error('mobile relay pairing journal identity mismatch')
    }
    await AsyncStorage.setItem(JOURNAL_STORAGE_KEY, JSON.stringify(next))
  })
  journalMutation = mutation.catch(() => {})
  return mutation
}

export async function clearMobileRelayPairingJournal(journalId: string): Promise<void> {
  const mutation = journalMutation.then(async () => {
    const raw = await AsyncStorage.getItem(JOURNAL_STORAGE_KEY)
    const current = raw ? parseMetadata(raw) : null
    if (current && current.journalId !== journalId) {
      throw new Error('stale mobile relay pairing journal')
    }
    await AsyncStorage.removeItem(JOURNAL_STORAGE_KEY)
    await SecureStore.deleteItemAsync(JOURNAL_SECRET_KEY, KEYCHAIN_OPTIONS)
  })
  journalMutation = mutation.catch(() => {})
  return mutation
}

function parseMetadata(raw: string): MobileRelayPairingJournalMetadata | null {
  try {
    const result = MobileRelayPairingJournalMetadataSchema.safeParse(JSON.parse(raw))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

function parseSecrets(raw: string) {
  try {
    const result = MobileRelayPairingJournalSecretsSchema.safeParse(JSON.parse(raw))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

function requireNativeSecretStore(): void {
  if (Platform.OS === 'web') {
    throw new Error('Orca Relay pairing requires a native secret store')
  }
}

/** Test-only: drain the module mutation chain between cases. */
export function resetMobileRelayPairingJournalStoreForTests(): void {
  journalMutation = Promise.resolve()
}
