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

// Single writer: appliedMode is fixed this launch; configuredMode takes effect after restart.

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

/** Back up unhealthy bytes before reset; refuse to reuse an existing backup path. */
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

/** Writes are synchronous; serialize them if persistence becomes asynchronous. */
export async function setBrowserIdentityMode(
  mode: BrowserUserAgentMode,
  options: { reset?: boolean } = {}
): Promise<BrowserIdentityModeSetResult> {
  const store = requireModeStore()
  const current = store.snapshot
  if (current.configuredMode === null) {
    // Unhealthy or newer data needs an explicit reset and a successful backup.
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
    // Publish the new snapshot only after the write succeeds.
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

/** Notice persistence is best-effort and must not block session startup. */
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
  // Retained per-profile records recur every launch; an explicit choice retires the notice.
  if (current.explicitSelection === true) {
    return false
  }
  // Show the notice even if the record cannot be updated.
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
