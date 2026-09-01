// Host-private durable persistence for the launch-operation store (U4). Both
// durable halves live in ONE file under the host data dir, never client-synced:
//   • the settled ledger — digests, status, terminal id, and failure id only,
//     non-sensitive by construction, so it is written in plaintext for restart
//     idempotency;
//   • the pending snapshots — they carry argv, the admitted agent env, and the
//     launch token, so they are encrypted at rest via Electron safeStorage (the
//     existing secret-settings standard). A pending snapshot that outlives a
//     main crash is what lets reconciliation re-attribute a terminal by its
//     token, so this map must be durable, not memory-only.
// The file is written with the same atomic tmp+rename + permission-hardening
// discipline as the other host credential stores, through the fsync'd writer:
// this state IS the crash-recovery record, so a rename that survives the crash
// but whose bytes do not would lose exactly what it exists to preserve. The
// encode/decode core takes an injected cipher so it is testable without Electron.

import { join } from 'node:path'
import { safeStorage } from 'electron'
import { readSecureJsonFile, writeDurableSecureJsonFile } from '../../shared/secure-file'
import type {
  AgentLaunchOperationStore,
  AgentLaunchOperationStoreDurableState,
  PendingAgentLaunchSnapshot,
  SettledAgentLaunchOperation
} from './agent-launch-operation-store'
import type { AdmittedLaunchRecord } from './agent-launch-admission-store'
import { getHostAgentLaunchOperationStore } from './agent-launch-operation-store-host'
import { getHostAgentLaunchBoundary } from './agent-launch-boundary-host'
import { getHostBackgroundAgentLaunchStore } from './background-agent-launch-store-host'
import { initHostBackgroundAgentLaunchStorePersistence } from './background-agent-launch-store-persistence'

const STORE_FILENAME = 'agent-launch-operations.json'

export function agentLaunchOperationStorePath(userDataPath: string): string {
  return join(userDataPath, STORE_FILENAME)
}

/** Crypto boundary for the encrypted pending section. Injected so the envelope
 *  round-trip is unit-testable without an Electron/OS keychain. */
export type AgentLaunchOperationCipher = {
  available: () => boolean
  encrypt: (plaintext: string) => Buffer
  decrypt: (ciphertext: Buffer) => string
}

export function electronSafeStorageCipher(): AgentLaunchOperationCipher {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext)
  }
}

type PersistedPendingSection =
  | { format: 'electron-safe-storage-v1'; ciphertext: string }
  // Plaintext fallback only when OS-backed encryption is unavailable; the file
  // itself is still permission-hardened. Matches the secret-settings standard.
  | { format: 'plaintext-v1'; snapshots: PendingAgentLaunchSnapshot[] }

type PersistedFile = {
  version: 1
  settled: SettledAgentLaunchOperation[]
  pending: PersistedPendingSection
}

export function encodeAgentLaunchOperationStore(
  state: AgentLaunchOperationStoreDurableState,
  cipher: AgentLaunchOperationCipher
): PersistedFile {
  const snapshots = [...state.pending]
  const pending: PersistedPendingSection = cipher.available()
    ? {
        format: 'electron-safe-storage-v1',
        ciphertext: cipher.encrypt(JSON.stringify(snapshots)).toString('base64')
      }
    : { format: 'plaintext-v1', snapshots }
  return { version: 1, settled: [...state.settled], pending }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Per-entry shape guard for rehydrated pending snapshots: reconciliation
 *  dereferences snapshot.target.executionHostId (and joins on the ids) with no
 *  per-entry try/catch, so one malformed entry must be skipped at load rather
 *  than throwing inside every reconcile pass. */
function isPendingAgentLaunchSnapshotShape(value: unknown): value is PendingAgentLaunchSnapshot {
  if (!isRecord(value)) {
    return false
  }
  const snapshot = value.snapshot
  return (
    typeof value.operationId === 'string' &&
    typeof value.idempotencyKey === 'string' &&
    typeof value.scope === 'string' &&
    (value.clientMutationId === null || typeof value.clientMutationId === 'string') &&
    typeof value.payloadDigest === 'string' &&
    typeof value.launchToken === 'string' &&
    typeof value.intent === 'string' &&
    isRecord(snapshot) &&
    Array.isArray(snapshot.argv) &&
    isRecord(snapshot.target) &&
    typeof snapshot.target.executionHostId === 'string'
  )
}

function isAdmissionPrincipalShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  return value.kind === 'local' || (value.kind === 'remote' && typeof value.id === 'string')
}

function validPendingSnapshots(entries: unknown[]): PendingAgentLaunchSnapshot[] {
  // A malformed principal is stripped rather than dropping the whole snapshot:
  // crash-recovery attribution matters more than the capacity bucket, and a
  // missing principal rebuilds as local.
  return entries.filter(isPendingAgentLaunchSnapshotShape).map((entry) => {
    if (entry.principal === undefined || isAdmissionPrincipalShape(entry.principal)) {
      return entry
    }
    const { principal: _dropped, ...rest } = entry
    return rest
  })
}

/** Load/decode outcome. `persistedStateUnreadable` marks persisted state that is
 *  intact on disk but unreadable NOW — either an encrypted pending section the
 *  OS cipher could not open (locked/late keychain) or a file this process could
 *  not read (EACCES/EBUSY/EMFILE/EIO). Either way the write-back sink must not
 *  attach, or the first mutation after boot overwrites the crash-recovery
 *  snapshots with the empty in-memory set. An ABSENT or corrupt file is NOT
 *  unreadable — there rewriting is the recovery, not a loss. */
export type AgentLaunchOperationStoreLoadResult = AgentLaunchOperationStoreDurableState & {
  persistedStateUnreadable: boolean
}

function decodePending(
  pending: unknown,
  cipher: AgentLaunchOperationCipher
): { snapshots: PendingAgentLaunchSnapshot[]; persistedStateUnreadable: boolean } {
  if (!isRecord(pending)) {
    return { snapshots: [], persistedStateUnreadable: false }
  }
  if (pending.format === 'plaintext-v1' && Array.isArray(pending.snapshots)) {
    return { snapshots: validPendingSnapshots(pending.snapshots), persistedStateUnreadable: false }
  }
  if (pending.format === 'electron-safe-storage-v1' && typeof pending.ciphertext === 'string') {
    if (!cipher.available()) {
      // Transient: a locked/late keychain at boot. The ciphertext is still
      // valid, so flag it rather than treating the store as empty.
      return { snapshots: [], persistedStateUnreadable: true }
    }
    // A decrypt failure with an AVAILABLE cipher (keychain reset) drops only the
    // pending map, never the whole file: reconciliation then treats those
    // launches conservatively rather than mis-attributing, and the settled
    // ledger stays intact.
    const decrypted = cipher.decrypt(Buffer.from(pending.ciphertext, 'base64'))
    const parsed = JSON.parse(decrypted)
    return {
      snapshots: Array.isArray(parsed) ? validPendingSnapshots(parsed) : [],
      persistedStateUnreadable: false
    }
  }
  return { snapshots: [], persistedStateUnreadable: false }
}

export function decodeAgentLaunchOperationStore(
  raw: unknown,
  cipher: AgentLaunchOperationCipher
): AgentLaunchOperationStoreLoadResult {
  if (!isRecord(raw) || raw.version !== 1) {
    return { pending: [], settled: [], persistedStateUnreadable: false }
  }
  const settled = Array.isArray(raw.settled) ? (raw.settled as SettledAgentLaunchOperation[]) : []
  try {
    const pending = decodePending(raw.pending, cipher)
    return {
      pending: pending.snapshots,
      settled,
      persistedStateUnreadable: pending.persistedStateUnreadable
    }
  } catch {
    return { pending: [], settled, persistedStateUnreadable: false }
  }
}

export function loadAgentLaunchOperationStoreState(
  path: string,
  cipher: AgentLaunchOperationCipher
): AgentLaunchOperationStoreLoadResult {
  const read = readSecureJsonFile(path)
  if (read.kind === 'unreadable') {
    // The ledger and snapshots are intact on disk, just not readable by this
    // process now. Reporting "empty" would let the sink destroy them.
    return { pending: [], settled: [], persistedStateUnreadable: true }
  }
  if (read.kind !== 'parsed') {
    // A corrupt ledger must never block boot; start empty and let the create/
    // retry path rebuild idempotency state from scratch.
    return { pending: [], settled: [], persistedStateUnreadable: false }
  }
  return decodeAgentLaunchOperationStore(read.value, cipher)
}

export function writeAgentLaunchOperationStoreState(
  path: string,
  state: AgentLaunchOperationStoreDurableState,
  cipher: AgentLaunchOperationCipher
): void {
  writeDurableSecureJsonFile(path, encodeAgentLaunchOperationStore(state, cipher))
}

/** Reconstruct the admission records the rehydrated pending snapshots hold
 *  capacity for, so a restart keeps counting launch_state_unknown launches
 *  against the per-host/per-principal caps and Forget's release finds them. */
export function admittedLaunchRecordsFromPendingSnapshots(
  pending: readonly PendingAgentLaunchSnapshot[],
  deps: {
    /** Background launches scope by attempt id; the attempt names the worktree. */
    worktreeIdForBackgroundScope: (attemptId: string) => string | null
    now: () => number
  }
): AdmittedLaunchRecord[] {
  return pending.map((entry) => ({
    launchToken: entry.launchToken,
    // Entries persisted before the principal field default to local: a
    // wrong-bucket count still holds capacity and releases by token.
    principal: entry.principal ?? { kind: 'local' },
    intent: entry.intent,
    scope: entry.scope,
    worktreeId:
      entry.intent === 'interactive' || entry.intent === 'cli' || entry.intent === 'resume'
        ? entry.scope
        : entry.intent === 'background'
          ? deps.worktreeIdForBackgroundScope(entry.scope)
          : null,
    // The fingerprint only guards the admission-time recheck and is never
    // re-read after commit; admittedAt only orders capacity-recovery rows.
    // Neither is persisted, so rebuild with stand-ins.
    fingerprint: entry.payloadDigest,
    snapshot: entry.snapshot,
    admittedAt: deps.now()
  }))
}

/** Cipher-injected core of the boot wiring, split out so the locked-keychain
 *  recovery path and the admission rebuild are unit-testable without Electron. */
export function initAgentLaunchOperationStorePersistence(
  store: AgentLaunchOperationStore,
  path: string,
  cipher: AgentLaunchOperationCipher,
  deps: {
    rebuildAdmission: (records: AdmittedLaunchRecord[]) => void
    worktreeIdForBackgroundScope: (attemptId: string) => string | null
    now?: () => number
  }
): void {
  const state = loadAgentLaunchOperationStoreState(path, cipher)
  // Pending first: the global settled-scope bound pins the scopes an in-flight
  // launch still needs, and it can only see them once they are rehydrated.
  store.rebuildPendingFrom(state.pending)
  store.rebuildSettledFrom(state.settled)
  // Re-take the capacity these rehydrated launches held before the restart;
  // Forget/reconcile then release the exact slot instead of no-opping.
  deps.rebuildAdmission(
    admittedLaunchRecordsFromPendingSnapshots(state.pending, {
      worktreeIdForBackgroundScope: deps.worktreeIdForBackgroundScope,
      now: deps.now ?? Date.now
    })
  )
  // The write THROWS to the mutating caller: this file is the idempotency,
  // recovery, and capacity record, so a launch whose snapshot never reached disk
  // must fail rather than report success and vanish on the next restart.
  const attachWriteBackSink = (): void => {
    store.setDurablePersistence((next) => {
      writeAgentLaunchOperationStoreState(path, next, cipher)
    })
  }
  if (!state.persistedStateUnreadable) {
    attachWriteBackSink()
    return
  }
  // Persisted state exists but could not be read at boot (locked/late keychain,
  // or an unreadable file). A plain write-back sink would overwrite it with the
  // empty in-memory map on the first mutation, so attach a recovery sink that
  // re-reads per durable mutation and, once the read succeeds, merges the
  // on-disk state under the in-memory one before taking over.
  store.setDurablePersistence(() => {
    const onDisk = loadAgentLaunchOperationStoreState(path, cipher)
    if (onDisk.persistedStateUnreadable) {
      // Still degraded: writing now would destroy intact bytes. Deferred, not
      // failed — the recovery sink stays armed and the next mutation retries.
      return
    }
    const live = store.durableState()
    // Maps key pendings by token and the ledger replaces by operationId in
    // settledAt order, so disk-first + live-second prefers the live state.
    const liveTokens = new Set(live.pending.map((entry) => entry.launchToken))
    store.rebuildPendingFrom([
      ...onDisk.pending.filter((entry) => !liveTokens.has(entry.launchToken)),
      ...live.pending
    ])
    store.rebuildSettledFrom([...onDisk.settled, ...live.settled])
    // Hand over to the plain sink only AFTER the merged write lands, so a failed
    // write both reaches the caller and leaves the recovery sink armed.
    writeAgentLaunchOperationStoreState(path, store.durableState(), cipher)
    attachWriteBackSink()
  })
}

/** Boot-time wiring: rehydrate the durable state (operation ledger + pending
 *  snapshots, the background attempt store, and the admission capacity those
 *  pendings hold), then attach the write-back sink so every later mutation is
 *  persisted. Called once from the main-process startup after the user data dir
 *  is stable. */
export function initHostAgentLaunchOperationStorePersistence(userDataPath: string): void {
  // The background attempt store rehydrates first so the admission rebuild
  // below can resolve background scopes (attempt ids) to their worktrees.
  // Chained here because this is the one durable launch-bookkeeping boot seam.
  initHostBackgroundAgentLaunchStorePersistence(userDataPath)
  initAgentLaunchOperationStorePersistence(
    getHostAgentLaunchOperationStore(),
    agentLaunchOperationStorePath(userDataPath),
    electronSafeStorageCipher(),
    {
      rebuildAdmission: (records) => getHostAgentLaunchBoundary().rebuildAdmissionFrom(records),
      worktreeIdForBackgroundScope: (attemptId) =>
        getHostBackgroundAgentLaunchStore().get(attemptId)?.worktreeId ?? null
    }
  )
}
