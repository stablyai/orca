import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import type {
  BrowserIdentityModeSetResult,
  BrowserIdentityModeSnapshot,
  BrowserIdentityModeStatus,
  BrowserUserAgentMode
} from '../../shared/browser-user-agent-mode'
import {
  BROWSER_IDENTITY_MODE_VERSION,
  browserIdentityModeRecordPath,
  readBrowserIdentityModeRecord,
  type BrowserIdentityModeReadResult,
  type BrowserIdentityModeRecord
} from './browser-identity-mode-record'

/**
 * The single writer for the process-wide browser identity.
 *
 * Preflight reads the root record before `ready` and hands its mode to the engine. The ready
 * phase used to mirror the *active Orca profile's* setting back into that record, so switching
 * from a native profile to a clean one started the clean profile in native. That second authority
 * is gone: the root record is the only one, and this module is its only writer.
 *
 * `appliedMode` is what this launch is actually presenting and never changes while the process
 * lives; `configuredMode` is what the next launch will take. `restartRequired` is derived from the
 * two rather than stored, so it cannot drift from them.
 */

type BrowserIdentityModeStore = {
  userDataPath: string
  snapshot: BrowserIdentityModeSnapshot
}

let modeStore: BrowserIdentityModeStore | null = null
const snapshotListeners = new Set<(snapshot: BrowserIdentityModeSnapshot) => void>()
let migrationNoticeDegraded = false
let launchMigrationNoticePending = false

function snapshotForRead(result: BrowserIdentityModeReadResult): BrowserIdentityModeSnapshot {
  return { ...result, restartRequired: false }
}

function writeRecord(userDataPath: string, record: BrowserIdentityModeRecord): void {
  const filePath = browserIdentityModeRecordPath(userDataPath)
  writeFileDurableSync(
    durableWriteTempPath(filePath),
    filePath,
    `${JSON.stringify(record, null, 2)}\n`
  )
}

/**
 * Copies unhealthy bytes to a fresh path before anything overwrites them. Byte-for-byte, and
 * never onto a name that already exists, so an explicit reset cannot be what loses the data.
 */
function backupUnhealthyRecord(userDataPath: string): string {
  const filePath = browserIdentityModeRecordPath(userDataPath)
  const bytes = readFileSync(filePath)
  const backupPath = `${filePath}.${Date.now()}.${randomUUID().slice(0, 8)}.bak`
  if (existsSync(backupPath)) {
    throw new Error(`Browser identity backup ${backupPath} already exists`)
  }
  writeFileDurableSync(durableWriteTempPath(backupPath), backupPath, bytes)
  return backupPath
}

/** Whether this host actually owns a browser identity, which is what the capability advertises. */
export function isBrowserIdentityModeStoreInitialized(): boolean {
  return modeStore !== null
}

export function initializeBrowserIdentityModeStore(
  userDataPath: string
): BrowserIdentityModeSnapshot {
  if (modeStore) {
    throw new Error('Browser identity mode store was already initialized')
  }
  const snapshot = snapshotForRead(readBrowserIdentityModeRecord(userDataPath))
  modeStore = { userDataPath, snapshot }
  return snapshot
}

function requireModeStore(): BrowserIdentityModeStore {
  if (!modeStore) {
    throw new Error('Browser identity mode store is not initialized')
  }
  return modeStore
}

export function getBrowserIdentityModeSnapshot(): BrowserIdentityModeSnapshot {
  return requireModeStore().snapshot
}

export function getBrowserIdentityMigrationNotice(): { degraded: boolean } | null {
  const snapshot = requireModeStore().snapshot
  return launchMigrationNoticePending || snapshot.migrationNoticePending === true
    ? { degraded: migrationNoticeDegraded }
    : null
}

export function getBrowserIdentityModeStatus(): BrowserIdentityModeStatus {
  return {
    identity: getBrowserIdentityModeSnapshot(),
    migrationNotice: getBrowserIdentityMigrationNotice()
  }
}

function notifySnapshotListeners(snapshot: BrowserIdentityModeSnapshot): void {
  for (const listener of snapshotListeners) {
    try {
      listener(snapshot)
    } catch (error) {
      console.error('[browser-identity] Snapshot listener failed:', error)
    }
  }
}

export function onBrowserIdentityModeSnapshotChanged(
  listener: (snapshot: BrowserIdentityModeSnapshot) => void
): () => void {
  snapshotListeners.add(listener)
  return () => snapshotListeners.delete(listener)
}

/**
 * Commits an explicit choice. The record lands durably before this resolves.
 *
 * No queue: writeRecord is synchronous end to end, so two calls cannot interleave and a
 * serialization layer here would be machinery no test could falsify. If durable writes ever
 * become async, reintroduce serialization with that change, where it is testable.
 */
export async function setBrowserIdentityMode(
  mode: BrowserUserAgentMode,
  options: { reset?: boolean } = {}
): Promise<BrowserIdentityModeSetResult> {
  const store = requireModeStore()
  const current = store.snapshot
  if (current.configuredMode === null) {
    // Why never automatic: the data may belong to a newer Orca, and overwriting it silently
    // would destroy the only copy. The caller has to ask, and the old bytes survive the ask.
    if (!options.reset) {
      return {
        ok: false,
        error: {
          code: 'browser_identity_reset_required',
          message:
            current.state === 'future'
              ? 'Browser identity data was written by a newer Orca; update Orca, or reset it explicitly to overwrite it.'
              : `Browser identity data is ${current.state}; reset it explicitly to overwrite it.`
        },
        identity: current
      }
    }
    try {
      backupUnhealthyRecord(store.userDataPath)
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'browser_identity_backup_failed',
          message: error instanceof Error ? error.message : String(error)
        },
        identity: current
      }
    }
  }
  const record: BrowserIdentityModeRecord = {
    version: BROWSER_IDENTITY_MODE_VERSION,
    mode,
    explicitSelection: true,
    migrationNoticePending: false
  }
  try {
    writeRecord(store.userDataPath, record)
  } catch (error) {
    // Why unchanged: a rejected write leaves disk on the old value, so reporting the new one
    // would make the UI and the next launch disagree.
    return {
      ok: false,
      error: {
        code: 'browser_identity_write_failed',
        message: error instanceof Error ? error.message : String(error)
      },
      identity: current
    }
  }
  const identity: BrowserIdentityModeSnapshot = {
    state: 'valid',
    appliedMode: current.appliedMode,
    configuredMode: mode,
    explicitSelection: true,
    migrationNoticePending: false,
    restartRequired: mode !== current.appliedMode
  }
  store.snapshot = identity
  launchMigrationNoticePending = false
  migrationNoticeDegraded = false
  notifySnapshotListeners(identity)
  return { ok: true, identity }
}

/**
 * Records that a launch found retired per-profile identity data. Best-effort by design: this is
 * bookkeeping, so a failure is reported and never allowed to gate session startup.
 */
export async function markBrowserIdentityMigrationNoticePending(
  userDataPath: string,
  degraded: boolean
): Promise<boolean> {
  if (!modeStore) {
    initializeBrowserIdentityModeStore(userDataPath)
  }
  const store = requireModeStore()
  if (store.userDataPath !== userDataPath) {
    throw new Error('Browser identity mode store userData path changed')
  }
  const current = store.snapshot
  // The retired per-profile bytes are retained on disk forever by design, so every launch
  // rediscovers them. An explicit choice is what retires the notice — without this gate the
  // notice re-arms on the launch after the user answers it, and on every launch after that.
  if (current.explicitSelection === true) {
    return false
  }
  // Why the in-memory flag regardless: the user still needs the notice even when the record
  // cannot be written, and unhealthy data has no mode to write it beside.
  launchMigrationNoticePending = true
  migrationNoticeDegraded ||= degraded
  if (current.configuredMode === null) {
    return false
  }
  const record: BrowserIdentityModeRecord = {
    version: BROWSER_IDENTITY_MODE_VERSION,
    mode: current.configuredMode,
    explicitSelection: current.explicitSelection,
    migrationNoticePending: true
  }
  try {
    writeRecord(userDataPath, record)
  } catch (error) {
    console.error('[browser-identity] Could not persist retired profile notice:', error)
    return false
  }
  store.snapshot = {
    state: 'valid',
    appliedMode: current.appliedMode,
    configuredMode: current.configuredMode,
    explicitSelection: current.explicitSelection,
    migrationNoticePending: true,
    restartRequired: current.restartRequired
  }
  notifySnapshotListeners(store.snapshot)
  return true
}

export function resetBrowserIdentityModeStoreForTests(): void {
  modeStore = null
  snapshotListeners.clear()
  migrationNoticeDegraded = false
  launchMigrationNoticePending = false
}
