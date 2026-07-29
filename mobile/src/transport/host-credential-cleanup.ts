import AsyncStorage from '@react-native-async-storage/async-storage'

const PENDING_STORAGE_KEY = 'orca:pending-host-credential-cleanups'
const CLEANUP_CONFIRM_TIMEOUT_MS = 3_000

type DeleteHostCredential = (hostId: string) => Promise<void>
type CleanupAttemptResult = 'cleared' | 'pending'
type CleanupOutcome = 'cleared' | 'failed' | 'timed-out'
type PendingIdsRead = { ok: true; ids: string[] } | { ok: false }

export type PendingHostCredentialCleanup = {
  ids: string[]
  // Why: the durable AsyncStorage queue could not be read. Settings surfaces a
  // "pending unknown / retry to be safe" state instead of a silently-empty
  // (hidden) section so an orphaned keychain token keeps a recovery affordance.
  storageUnreadable: boolean
}

let pendingMutation: Promise<void> = Promise.resolve()
const pendingListeners = new Set<() => void>()
// Why: concurrent taps/callers share one native operation while it is being
// confirmed. A timed-out operation is released so the next user tap can retry.
const inflightDeletes = new Map<string, Promise<void>>()
// Why: when the durable queue write fails we still need a recovery handle for a
// failed keychain delete. Keep the hostId here (session-scoped) so Settings can
// surface it and offer a retry; cleared once the native delete confirms.
const unrecordedPendingIds = new Set<string>()

function notifyPendingListeners(): void {
  for (const listener of pendingListeners) {
    listener()
  }
}

function markUnrecordedPending(hostId: string): void {
  if (unrecordedPendingIds.has(hostId)) {
    return
  }
  unrecordedPendingIds.add(hostId)
  notifyPendingListeners()
}

function clearUnrecordedPending(hostId: string): void {
  if (unrecordedPendingIds.delete(hostId)) {
    notifyPendingListeners()
  }
}

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

async function loadPendingCleanupState(): Promise<PendingHostCredentialCleanup> {
  await pendingMutation
  const result = await readPendingIdsForMutation()
  const fallback = [...unrecordedPendingIds]
  if (!result.ok) {
    // Why: durable queue unreadable — only the session-scoped fallback is
    // known. Report unreadable so callers can surface a retry rather than
    // pretend the queue is empty.
    return { ids: [...new Set(fallback)], storageUnreadable: true }
  }
  return { ids: [...new Set([...result.ids, ...fallback])], storageUnreadable: false }
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
    notifyPendingListeners()
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

async function recordCleanupIntent(hostId: string): Promise<boolean> {
  try {
    await addPendingId(hostId)
    return true
  } catch {
    return false
  }
}

async function confirmNativeCleanup(
  hostId: string,
  deleteCredential: DeleteHostCredential,
  timeoutMs: number
): Promise<CleanupAttemptResult> {
  const cleanup = startOrJoinDelete(hostId, deleteCredential)
  // Why: attach before observing so a success that races the confirm timeout
  // still clears the queue entry (including after timed-out returns). Clears the
  // session-scoped fallback too, so a durable-write-failed intent stops being
  // surfaced once the native delete finally lands.
  const clearWhenDeleted = cleanup.then(
    () => {
      clearUnrecordedPending(hostId)
      return removePendingId(hostId).catch(() => undefined)
    },
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

export async function loadPendingHostCredentialCleanup(): Promise<PendingHostCredentialCleanup> {
  return loadPendingCleanupState()
}

export async function loadPendingHostCredentialCleanupIds(): Promise<string[]> {
  return (await loadPendingCleanupState()).ids
}

export function subscribePendingHostCredentialCleanup(listener: () => void): () => void {
  pendingListeners.add(listener)
  return () => pendingListeners.delete(listener)
}

/**
 * Record cleanup intent, then fire-and-forget the native keychain delete so
 * removeHost never blocks on SecureStore. If the durable intent write fails,
 * keep a session-scoped recovery handle so a failed keychain delete still
 * surfaces in Settings instead of orphaning the token with no retry affordance.
 */
export async function scheduleHostCredentialCleanup(
  hostId: string,
  deleteCredential: DeleteHostCredential,
  timeoutMs = CLEANUP_CONFIRM_TIMEOUT_MS
): Promise<void> {
  const recorded = await recordCleanupIntent(hostId)
  if (!recorded) {
    // Why: the only durable recovery handle failed to persist. Hold an in-memory
    // one so Settings can still surface + retry; confirmNativeCleanup clears it
    // if the native delete lands. removeHost stays non-blocking (freeze fix).
    markUnrecordedPending(hostId)
  }
  void confirmNativeCleanup(hostId, deleteCredential, timeoutMs).catch(() => {})
}

export async function retryPendingHostCredentialCleanups(
  deleteCredential: DeleteHostCredential
): Promise<{ clearedCount: number; remainingIds: string[]; storageUnreadable: boolean }> {
  const pending = await loadPendingCleanupState()
  const outcomes = await Promise.all(
    // Why: these ids are already durable (or a session-scoped fallback). Re-adding
    // intent can race a late success and recreate a ghost row after deletion.
    pending.ids.map((id) => confirmNativeCleanup(id, deleteCredential, CLEANUP_CONFIRM_TIMEOUT_MS))
  )
  const remaining = await loadPendingCleanupState()
  return {
    clearedCount: outcomes.filter((outcome) => outcome === 'cleared').length,
    remainingIds: remaining.ids,
    storageUnreadable: remaining.storageUnreadable
  }
}

/** Test-only: drop module listeners/in-flight state between cases. */
export function resetHostCredentialCleanupForTests(): void {
  inflightDeletes.clear()
  pendingListeners.clear()
  unrecordedPendingIds.clear()
  pendingMutation = Promise.resolve()
}
