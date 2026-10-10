import AsyncStorage from '@react-native-async-storage/async-storage'
import { Platform } from 'react-native'
import {
  MobileRelayPairingJournalMetadataSchema,
  MobileRelayPairingJournalSecretsSchema,
  type MobileRelayPairingJournal,
  type MobileRelayPairingJournalMetadata
} from './mobile-relay-pairing-journal'
import {
  deletePairingKeychainItem,
  readPairingKeychainItem,
  resetPairingKeychainForTests,
  writePairingKeychainItem
} from './pairing-keychain'

const JOURNAL_STORAGE_KEY = 'orca:mobile-relay:pairing-journal:v1'
const JOURNAL_SECRET_KEY = 'orca.mobile-relay.pairing-journal.v1'
let journalMutation: Promise<void> = Promise.resolve()
// Journals whose pairing attempt is still running in this process. Only these
// are protected from replacement; a journal left by an ended attempt or an
// earlier launch belongs to recovery, which a new scan supersedes.
const inFlightJournalIds = new Set<string>()
// Journals recovery is publishing right now; a superseding save waits for them.
const publications = new Map<string, Promise<void>>()

export async function saveMobileRelayPairingJournal(
  journal: MobileRelayPairingJournal
): Promise<void> {
  requireNativeSecretStore()
  const metadata = MobileRelayPairingJournalMetadataSchema.parse(journal.metadata)
  const secrets = MobileRelayPairingJournalSecretsSchema.parse(journal.secrets)
  if (metadata.journalId !== secrets.journalId) {
    throw new Error('mobile relay pairing journal identity mismatch')
  }
  for (;;) {
    const blocked = await replaceJournal(metadata, secrets)
    if (!blocked) {
      return
    }
    // Why: waiting outside the mutation chain lets the publication clear its journal.
    await blocked.publication
  }
}

function replaceJournal(
  metadata: MobileRelayPairingJournalMetadata,
  secrets: MobileRelayPairingJournal['secrets']
): Promise<{ publication: Promise<void> } | null> {
  const mutation = journalMutation.then(async () => {
    const existingRaw = await AsyncStorage.getItem(JOURNAL_STORAGE_KEY)
    const existing = existingRaw ? parseMetadata(existingRaw) : null
    const publication = existing ? publications.get(existing.journalId) : undefined
    if (publication && existing?.journalId !== metadata.journalId) {
      return { publication }
    }
    if (
      existing &&
      existing.journalId !== metadata.journalId &&
      inFlightJournalIds.has(existing.journalId) &&
      (existing.winner !== undefined || existing.authorizationMode !== undefined)
    ) {
      // Why: an authorized attempt may have its install RPC in flight right now.
      throw new Error('mobile relay pairing in progress')
    }
    // Why: metadata-first makes a crash before the keychain write recover as
    // an incomplete journal, never as an untracked bearer secret.
    await AsyncStorage.setItem(JOURNAL_STORAGE_KEY, JSON.stringify(metadata))
    await writePairingKeychainItem(JOURNAL_SECRET_KEY, JSON.stringify(secrets))
    if (existing) {
      inFlightJournalIds.delete(existing.journalId)
    }
    inFlightJournalIds.add(metadata.journalId)
    return null
  })
  journalMutation = mutation.then(
    () => undefined,
    () => undefined
  )
  return mutation
}

// Recovery publishes a committed install only while its journal is still the
// stored one, and a superseding scan waits until that publication releases, so
// a late recovery can never overwrite the credentials a newer pairing wrote.
export async function claimMobileRelayPairingJournalPublication(
  journalId: string
): Promise<() => void> {
  let release = (): void => {}
  const done = new Promise<void>((resolve) => {
    release = resolve
  })
  const claim = journalMutation.then(async () => {
    const raw = await AsyncStorage.getItem(JOURNAL_STORAGE_KEY)
    if ((raw ? parseMetadata(raw) : null)?.journalId !== journalId) {
      throw new Error('stale mobile relay pairing journal')
    }
    publications.set(journalId, done)
  })
  journalMutation = claim.catch(() => {})
  await claim
  return () => {
    publications.delete(journalId)
    release()
  }
}

export async function loadMobileRelayPairingJournal(): Promise<MobileRelayPairingJournal | null> {
  requireNativeSecretStore()
  const load = journalMutation.then(async () => {
    const rawMetadata = await AsyncStorage.getItem(JOURNAL_STORAGE_KEY)
    if (rawMetadata === null) {
      await deletePairingKeychainItem(JOURNAL_SECRET_KEY).catch(() => {})
      return null
    }
    const metadata = parseMetadata(rawMetadata)
    if (!metadata) {
      await removeIncompleteJournal()
      return null
    }
    const rawSecrets = await readPairingKeychainItem(JOURNAL_SECRET_KEY)
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
  })
  // Why: recovery may load while a new scan saves; serialize the complete
  // metadata/secret snapshot and any cleanup so it cannot delete the new journal.
  journalMutation = load.then(
    () => undefined,
    () => undefined
  )
  return load
}

async function removeIncompleteJournal(): Promise<void> {
  // Why: metadata is the discoverable cleanup pointer; remove it before the
  // native secret so a second crash can only leave a self-cleaning orphan.
  await AsyncStorage.removeItem(JOURNAL_STORAGE_KEY)
  await deletePairingKeychainItem(JOURNAL_SECRET_KEY).catch(() => {})
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
    await deletePairingKeychainItem(JOURNAL_SECRET_KEY)
    inFlightJournalIds.delete(journalId)
  })
  journalMutation = mutation.catch(() => {})
  return mutation
}

// The attempt that saved this journal ended; the journal stays for recovery,
// and a later scan may replace it.
export function releaseMobileRelayPairingJournal(journalId: string): void {
  inFlightJournalIds.delete(journalId)
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
  inFlightJournalIds.clear()
  publications.clear()
  resetPairingKeychainForTests()
}
