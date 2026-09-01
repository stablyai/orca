// Host-private durable persistence for the session record store (U5). Records
// carry the immutable launch snapshot (resolved argv + admitted agent env) and,
// for legacy handoffs, the opaque replay config — both secret-bearing — plus the
// launch token, so the whole record set is encrypted at rest via Electron
// safeStorage (the secret-settings standard), with a permission-hardened plaintext
// fallback only when OS-backed encryption is unavailable. Written with the same
// atomic tmp+rename + fsync discipline as the launch-operation store — a record
// whose bytes never reached the platter is a session that cannot be resumed. The
// encode/decode core takes an injected cipher so the envelope round-trip is
// testable without Electron. This file is never client-synced.

import { join } from 'node:path'
import { safeStorage } from 'electron'
import { readSecureJsonFile, writeDurableSecureJsonFile } from '../../shared/secure-file'
import type {
  AgentSessionRecordStore,
  AgentSessionRecordStoreDurableState,
  HostSessionLaunchRecord
} from './agent-session-record-store'
import { getHostAgentSessionRecordStore } from './agent-session-record-store-host'

const STORE_FILENAME = 'agent-session-records.json'

export function agentSessionRecordStorePath(userDataPath: string): string {
  return join(userDataPath, STORE_FILENAME)
}

/** Crypto boundary for the encrypted records section. Injected so the envelope
 *  round-trip is unit-testable without an Electron/OS keychain. */
export type AgentSessionRecordCipher = {
  available: () => boolean
  encrypt: (plaintext: string) => Buffer
  decrypt: (ciphertext: Buffer) => string
}

export function electronSafeStorageCipher(): AgentSessionRecordCipher {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext)
  }
}

type PersistedRecordsSection =
  | { format: 'electron-safe-storage-v1'; ciphertext: string }
  | { format: 'plaintext-v1'; records: HostSessionLaunchRecord[] }

type PersistedFile = {
  version: 1
  records: PersistedRecordsSection
}

export function encodeAgentSessionRecordStore(
  state: AgentSessionRecordStoreDurableState,
  cipher: AgentSessionRecordCipher
): PersistedFile {
  const records = [...state.records]
  const section: PersistedRecordsSection = cipher.available()
    ? {
        format: 'electron-safe-storage-v1',
        ciphertext: cipher.encrypt(JSON.stringify(records)).toString('base64')
      }
    : { format: 'plaintext-v1', records }
  return { version: 1, records: section }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Load/decode outcome. `persistedStateUnreadable` marks persisted records that
 *  are intact on disk but unreadable NOW — either an encrypted section the OS
 *  cipher could not open (locked/late keychain) or a file this process could not
 *  read (EACCES/EBUSY/EMFILE/EIO). Both mean the same thing to the caller:
 *  write-back must be skipped, or the next durable mutation overwrites the
 *  persisted set with the empty one. An ABSENT or structurally corrupt file is
 *  NOT unreadable — there rewriting is the recovery, not a loss. */
export type AgentSessionRecordStoreLoadResult = {
  records: HostSessionLaunchRecord[]
  persistedStateUnreadable: boolean
}

function decodeRecords(
  section: unknown,
  cipher: AgentSessionRecordCipher
): AgentSessionRecordStoreLoadResult {
  if (!isRecord(section)) {
    return { records: [], persistedStateUnreadable: false }
  }
  if (section.format === 'plaintext-v1' && Array.isArray(section.records)) {
    return {
      records: section.records as HostSessionLaunchRecord[],
      persistedStateUnreadable: false
    }
  }
  if (section.format === 'electron-safe-storage-v1' && typeof section.ciphertext === 'string') {
    if (!cipher.available()) {
      // Transient: a locked/late keychain at boot. The ciphertext is still
      // valid, so flag it rather than treating the store as empty.
      return { records: [], persistedStateUnreadable: true }
    }
    // A decrypt failure with an AVAILABLE cipher (keychain reset) is permanent:
    // it drops only the records, never blocks boot — those sessions then require
    // an explicit current-settings relaunch rather than a mis-attributed replay.
    const parsed = JSON.parse(cipher.decrypt(Buffer.from(section.ciphertext, 'base64')))
    return {
      records: Array.isArray(parsed) ? (parsed as HostSessionLaunchRecord[]) : [],
      persistedStateUnreadable: false
    }
  }
  return { records: [], persistedStateUnreadable: false }
}

export function decodeAgentSessionRecordStore(
  raw: unknown,
  cipher: AgentSessionRecordCipher
): AgentSessionRecordStoreLoadResult {
  if (!isRecord(raw) || raw.version !== 1) {
    return { records: [], persistedStateUnreadable: false }
  }
  try {
    return decodeRecords(raw.records, cipher)
  } catch {
    return { records: [], persistedStateUnreadable: false }
  }
}

export function loadAgentSessionRecordStoreState(
  path: string,
  cipher: AgentSessionRecordCipher
): AgentSessionRecordStoreLoadResult {
  const read = readSecureJsonFile(path)
  if (read.kind === 'unreadable') {
    // The records are intact on disk, just not readable by this process right
    // now. Reporting "empty" here would let the write-back sink destroy them.
    return { records: [], persistedStateUnreadable: true }
  }
  if (read.kind !== 'parsed') {
    // Absent or corrupt: a corrupt store must never block boot; start empty and
    // let live sessions rebind on their next hook.
    return { records: [], persistedStateUnreadable: false }
  }
  return decodeAgentSessionRecordStore(read.value, cipher)
}

export function writeAgentSessionRecordStoreState(
  path: string,
  state: AgentSessionRecordStoreDurableState,
  cipher: AgentSessionRecordCipher
): void {
  writeDurableSecureJsonFile(path, encodeAgentSessionRecordStore(state, cipher))
}

/** Boot-time wiring: rehydrate durable records, then attach the write-back sink so
 *  every later bind/ingest/forget is persisted. Called once from main-process
 *  startup after the user data dir is stable. */
export function initHostAgentSessionRecordStorePersistence(userDataPath: string): void {
  const path = agentSessionRecordStorePath(userDataPath)
  const cipher = electronSafeStorageCipher()
  initAgentSessionRecordStorePersistence(getHostAgentSessionRecordStore(), path, cipher)
}

/** Cipher-injected core of the boot wiring, split out so the locked-keychain
 *  recovery path is unit-testable without Electron. */
export function initAgentSessionRecordStorePersistence(
  store: AgentSessionRecordStore,
  path: string,
  cipher: AgentSessionRecordCipher
): void {
  const state = loadAgentSessionRecordStoreState(path, cipher)
  store.rebuildRecordsFrom(state.records)
  // The write THROWS to the mutating caller: a bind that reports success while
  // its record never reached disk is a session the owner loses on restart.
  const attachWriteBackSink = (): void => {
    store.setDurablePersistence((next) => {
      writeAgentSessionRecordStoreState(path, next, cipher)
    })
  }
  if (!state.persistedStateUnreadable) {
    attachWriteBackSink()
    return
  }
  // Persisted records exist but could not be read at boot (locked/late keychain,
  // or an unreadable file). A plain write-back sink would overwrite them with
  // the empty in-memory set on the first mutation, so instead attach a recovery
  // sink that re-reads on each durable mutation. Once the load comes back clean,
  // the on-disk records are merged UNDER the in-memory ones (fresh binds win
  // their ownership keys), the write-back sink takes over, and later forgets
  // stick instead of resurrecting next boot.
  store.recordCompleteness.markIncomplete()
  store.setDurablePersistence(() => {
    const onDisk = loadAgentSessionRecordStoreState(path, cipher)
    if (onDisk.persistedStateUnreadable) {
      // Still degraded — write nothing and keep the recovery sink armed.
      return
    }
    store.mergeRehydratedRecords(onDisk.records)
    // Hand over to the plain sink only AFTER the merged write lands, so a failed
    // write both reaches the caller and leaves the recovery sink armed.
    writeAgentSessionRecordStoreState(path, store.durableState(), cipher)
    store.recordCompleteness.markComplete()
    attachWriteBackSink()
  })
}
