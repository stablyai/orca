import AsyncStorage from '@react-native-async-storage/async-storage'

const PENDING_STORAGE_KEY = 'orca:pending-host-credential-cleanups'
const CLEANUP_CONFIRM_TIMEOUT_MS = 3_000

type DeleteHostCredential = (hostId: string) => Promise<void>
type CleanupAttemptResult = 'cleared' | 'pending'
type CleanupOutcome = 'cleared' | 'failed' | 'timed-out'
type PendingIdsRead = { ok: true; ids: string[] } | { ok: false }

let pendingMutation: Promise<void> = Promise.resolve()
const pendingListeners = new Set<() => void>()
// Why: concurrent taps/callers share one native operation while it is being
// confirmed. A timed-out operation is released so the next user tap can retry.
const inflightDeletes = new Map<string, Promise<void>>()

function parsePendingIds(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return null
    }
    return [...new Set(parsed.filter((value): value is string => typeof value === 'string'))]
  } catch {
    return null
  }
}

function sameIdList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

async function readPendingIdsForMutation(): Promise<PendingIdsRead> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_STORAGE_KEY)
    if (raw === null) {
      return { ok: true, ids: [] }
    }
    const ids = parsePendingIds(raw)
    if (!ids) {
      // Why: refuse to RMW over unreadable payload — treating it as [] would
      // wipe durable pending ids on the next add/remove.
      return { ok: false }
    }
    return { ok: true, ids }
  } catch {
    return { ok: false }
  }
}

async function readPendingIdsSoft(): Promise<string[]> {
  const result = await readPendingIdsForMutation()
  return result.ok ? result.ids : []
}

async function mutatePendingIds(update: (ids: string[]) => string[]): Promise<void> {
  const mutation = pendingMutation.then(async () => {
    const current = await readPendingIdsForMutation()
    if (!current.ok) {
      throw new Error('pending host credential cleanup storage unreadable')
    }
    const next = update(current.ids)
    if (sameIdList(current.ids, next)) {
      return
    }
    await AsyncStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(next))
    for (const listener of pendingListeners) {
      listener()
    }
  })
  pendingMutation = mutation.catch(() => {})
  return mutation
}

async function addPendingId(hostId: string): Promise<void> {
  await mutatePendingIds((ids) => (ids.includes(hostId) ? ids : [...ids, hostId]))
}

async function removePendingId(hostId: string): Promise<void> {
  await mutatePendingIds((ids) => ids.filter((id) => id !== hostId))
}

function observeCleanup(cleanup: Promise<void>, timeoutMs: number): Promise<CleanupOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: CleanupOutcome) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve(outcome)
    }
    const timeout = setTimeout(() => finish('timed-out'), timeoutMs)
    cleanup.then(
      () => finish('cleared'),
      () => finish('failed')
    )
  })
}

function startOrJoinDelete(hostId: string, deleteCredential: DeleteHostCredential): Promise<void> {
  const existing = inflightDeletes.get(hostId)
  if (existing) {
    return existing
  }
  const cleanup = Promise.resolve()
    .then(() => deleteCredential(hostId))
    .finally(() => {
      if (inflightDeletes.get(hostId) === cleanup) {
        inflightDeletes.delete(hostId)
      }
    })
  inflightDeletes.set(hostId, cleanup)
  return cleanup
}

async function recordCleanupIntent(hostId: string): Promise<void> {
  try {
    await addPendingId(hostId)
  } catch {
    // Best-effort native delete can still proceed without a durable row.
  }
}

async function confirmNativeCleanup(
  hostId: string,
  deleteCredential: DeleteHostCredential,
  timeoutMs: number
): Promise<CleanupAttemptResult> {
  const cleanup = startOrJoinDelete(hostId, deleteCredential)
  // Why: attach before observing so a success that races the confirm timeout
  // still clears the durable queue entry (including after timed-out returns).
  const clearWhenDeleted = cleanup.then(
    () => removePendingId(hostId).catch(() => undefined),
    () => undefined
  )
  const outcome = await observeCleanup(cleanup, timeoutMs)
  if (outcome === 'cleared') {
    await clearWhenDeleted
    return 'cleared'
  }

  if (outcome === 'timed-out' && inflightDeletes.get(hostId) === cleanup) {
    // Why: timing out is the boundary between automatic work and a future
    // user-owned retry. Releasing only the dedupe entry does not start work.
    inflightDeletes.delete(hostId)
  }

  // Why: failed/unconfirmed attempts stay user-owned; nothing auto-retries.
  void clearWhenDeleted
  return 'pending'
}

export async function loadPendingHostCredentialCleanupIds(): Promise<string[]> {
  await pendingMutation
  return readPendingIdsSoft()
}

export function subscribePendingHostCredentialCleanup(listener: () => void): () => void {
  pendingListeners.add(listener)
  return () => pendingListeners.delete(listener)
}

/**
 * Await only durable intent (AsyncStorage). Native keychain delete is
 * fire-and-forget so removeHost never blocks on SecureStore.
 */
export async function scheduleHostCredentialCleanup(
  hostId: string,
  deleteCredential: DeleteHostCredential,
  timeoutMs = CLEANUP_CONFIRM_TIMEOUT_MS
): Promise<void> {
  await recordCleanupIntent(hostId)
  void confirmNativeCleanup(hostId, deleteCredential, timeoutMs).catch(() => {})
}

export async function retryPendingHostCredentialCleanups(
  deleteCredential: DeleteHostCredential
): Promise<{ clearedCount: number; remainingIds: string[] }> {
  const ids = await loadPendingHostCredentialCleanupIds()
  const outcomes = await Promise.all(
    // Why: these ids are already durable. Re-adding intent can race a late
    // success and recreate a ghost row after the credential was deleted.
    ids.map((id) => confirmNativeCleanup(id, deleteCredential, CLEANUP_CONFIRM_TIMEOUT_MS))
  )
  const remainingIds = await loadPendingHostCredentialCleanupIds()
  return {
    clearedCount: outcomes.filter((outcome) => outcome === 'cleared').length,
    remainingIds
  }
}

/** Test-only: drop module listeners/in-flight state between cases. */
export function resetHostCredentialCleanupForTests(): void {
  inflightDeletes.clear()
  pendingListeners.clear()
  pendingMutation = Promise.resolve()
}
