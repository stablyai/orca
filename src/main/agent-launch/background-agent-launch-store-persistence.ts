// Host-private durable persistence for the generic background-attempt store
// (U6). The store's contract is that an unattended failure SURVIVES RELOAD and
// keeps rendering its recovery card on the worktree, so the attempts must be on
// disk, not memory-only. Every field is client-safe by construction (ids,
// display attribution, code+hint failure — never argv/env/token; see
// shared/background-agent-launch.ts), so the file is plaintext JSON, written
// with the same atomic tmp+rename + fsync + permission-hardening discipline as
// the sibling launch stores — surviving reload is the store's whole contract, so
// the bytes must outlive a power loss too. Each row re-validates through the
// strict shared schema on load so one corrupt entry never aborts the rest.

import { join } from 'node:path'
import { readSecureJsonFile, writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  parseBackgroundAgentLaunchAttempt,
  type BackgroundAgentLaunchAttempt
} from '../../shared/background-agent-launch'
import type { BackgroundAgentLaunchStore } from './background-agent-launch-store'
import { getHostBackgroundAgentLaunchStore } from './background-agent-launch-store-host'

const STORE_FILENAME = 'background-agent-launches.json'

export function backgroundAgentLaunchStorePath(userDataPath: string): string {
  return join(userDataPath, STORE_FILENAME)
}

type PersistedFile = {
  version: 1
  attempts: BackgroundAgentLaunchAttempt[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Load outcome. `persistedStateUnreadable` marks attempts that are intact on
 *  disk but unreadable by this process NOW (EACCES/EBUSY/EMFILE/EIO): the caller
 *  must skip write-back, or the next mutation overwrites the persisted attempts
 *  with the empty in-memory set and the recovery cards vanish permanently. An
 *  ABSENT or corrupt file is not unreadable — there rewriting IS the recovery. */
export type BackgroundAgentLaunchStoreLoadResult = {
  attempts: BackgroundAgentLaunchAttempt[]
  persistedStateUnreadable: boolean
}

export function loadBackgroundAgentLaunchAttempts(
  path: string
): BackgroundAgentLaunchStoreLoadResult {
  const read = readSecureJsonFile(path)
  if (read.kind === 'unreadable') {
    return { attempts: [], persistedStateUnreadable: true }
  }
  if (read.kind !== 'parsed') {
    // A corrupt store must never block boot; start empty and let reconciliation
    // rebuild what the live terminals still evidence.
    return { attempts: [], persistedStateUnreadable: false }
  }
  const raw = read.value
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.attempts)) {
    return { attempts: [], persistedStateUnreadable: false }
  }
  return {
    attempts: raw.attempts
      .map((entry) => parseBackgroundAgentLaunchAttempt(entry))
      .filter((attempt): attempt is BackgroundAgentLaunchAttempt => attempt !== null),
    persistedStateUnreadable: false
  }
}

export function writeBackgroundAgentLaunchAttempts(
  path: string,
  attempts: readonly BackgroundAgentLaunchAttempt[]
): void {
  const file: PersistedFile = { version: 1, attempts: [...attempts] }
  writeDurableSecureJsonFile(path, file)
}

/** Path-injected core of the boot wiring, split out so the rebuild + sink
 *  round-trip is unit-testable against a temp dir. */
export function initBackgroundAgentLaunchStorePersistence(
  store: BackgroundAgentLaunchStore,
  path: string
): void {
  const state = loadBackgroundAgentLaunchAttempts(path)
  store.rebuildFrom(state.attempts)
  // The write THROWS to the mutating caller: an attempt that reports success
  // while its row never reached disk loses the recovery card on the next reload.
  const attachWriteBackSink = (): void => {
    store.setDurablePersistence((next) => {
      writeBackgroundAgentLaunchAttempts(path, next.attempts)
    })
  }
  if (!state.persistedStateUnreadable) {
    attachWriteBackSink()
    return
  }
  // Attempts exist on disk but could not be read at boot. A plain write-back
  // sink would erase them — and with them the unattended-failure recovery cards
  // the store exists to keep alive — on the first mutation, so re-read on each
  // durable mutation instead and only take over once a read succeeds.
  store.attemptCompleteness.markIncomplete()
  store.setDurablePersistence(() => {
    const onDisk = loadBackgroundAgentLaunchAttempts(path)
    if (onDisk.persistedStateUnreadable) {
      // Still degraded — write nothing and keep the recovery sink armed.
      return
    }
    store.mergeRehydratedAttempts(onDisk.attempts)
    // Hand over to the plain sink only AFTER the merged write lands, so a failed
    // write both reaches the caller and leaves the recovery sink armed.
    writeBackgroundAgentLaunchAttempts(path, store.durableState().attempts)
    store.attemptCompleteness.markComplete()
    attachWriteBackSink()
  })
}

/** Boot-time wiring: rehydrate durable attempts, then attach the write-back
 *  sink so every later create/settle/forget is persisted. Called once from the
 *  launch-bookkeeping boot seam after the user data dir is stable. */
export function initHostBackgroundAgentLaunchStorePersistence(userDataPath: string): void {
  initBackgroundAgentLaunchStorePersistence(
    getHostBackgroundAgentLaunchStore(),
    backgroundAgentLaunchStorePath(userDataPath)
  )
}
