// Installs the process-wide payload retention under a state directory, once.
// Why a separate install site from the structured-session host: terminal-mode
// workers are read through `orchestration.workerRead` without ever opening a
// structured session, and a fresh app that only runs those must still retain
// what it clips. Every runtime constructs its retention here, eagerly.

import { join } from 'node:path'
import {
  DEFAULT_PAYLOAD_RETENTION_AGE_MS,
  DEFAULT_PAYLOAD_RETENTION_TOTAL_BYTES,
  JournalPayloadStore,
  PAYLOAD_STORE_DIR_NAME
} from './journal-payload-store'
import {
  getDefaultJournalPayloadRetention,
  setDefaultJournalPayloadRetention
} from './journal-payload-retention-default'

export type JournalPayloadRetentionInstallInput = {
  /** The root the journals use; the store lives beside them. */
  stateDirectory: string
  onError?: (input: { scope: string; error: unknown }) => void
}

let installedDirectory: string | null = null

/** Idempotent for one directory: a second call for the same root keeps the
 *  installed store. A different root replaces it, which only a test does. */
export function ensureJournalPayloadRetention(
  input: JournalPayloadRetentionInstallInput
): JournalPayloadStore {
  const directory = join(input.stateDirectory, PAYLOAD_STORE_DIR_NAME)
  const current = getDefaultJournalPayloadRetention()
  if (current instanceof JournalPayloadStore && installedDirectory === directory) {
    return current
  }
  const store = new JournalPayloadStore({ directory })
  setDefaultJournalPayloadRetention(store)
  installedDirectory = directory
  void Promise.resolve()
    .then(() =>
      store.prune({
        maxAgeMs: DEFAULT_PAYLOAD_RETENTION_AGE_MS,
        maxTotalBytes: DEFAULT_PAYLOAD_RETENTION_TOTAL_BYTES
      })
    )
    .catch((error: unknown) => {
      input.onError?.({ scope: 'agent-session-payload-retention', error })
    })
  return store
}

/** Drops the installed retention (process shutdown, tests). */
export function clearJournalPayloadRetention(): void {
  installedDirectory = null
  setDefaultJournalPayloadRetention(null)
}
