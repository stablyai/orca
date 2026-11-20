import AsyncStorage from '@react-native-async-storage/async-storage'

const PENDING_STORAGE_KEY = 'orca:pending-host-credential-cleanups'
const CLEANUP_CONFIRM_TIMEOUT_MS = 3_000

type DeleteHostCredential = (hostId: string) => Promise<void>
type CleanupAttemptResult = 'cleared' | 'pending'
type CleanupOutcome = 'cleared' | 'failed' | 'timed-out'
type PendingIdsRead = { ok: true; ids: string[] } | { ok: false }

export type PendingHostCredentialCleanup = {
  ids: string[]
  // Expose unreadable cleanup state so Settings still offers recovery for potentially orphaned tokens.
  storageUnreadable: boolean
}

let pendingMutation: Promise<void> = Promise.resolve()
const pendingListeners = new Set<() => void>()
// Coalesce native deletes until confirmation or timeout; later user retries may start another.
const inflightDeletes = new Map<string, Promise<void>>()
// Keep session recovery ids when durable intent fails; clear only after confirmed native deletion.
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
      // Never mutate unreadable intent as an empty list; that would erase durable pending ids.
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
    // Only fallback ids are known; preserve unreadable status so Settings offers retry.
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
    await recordHostCredentialCleanupIntent(hostId)
    return true
  } catch {
    return false
  }
}

export async function recordHostCredentialCleanupIntent(hostId: string): Promise<void> {
  await addPendingId(hostId)
}

async function confirmNativeCleanup(
  hostId: string,
  deleteCredential: DeleteHostCredential,
  timeoutMs: number
): Promise<CleanupAttemptResult> {
  const cleanup = startOrJoinDelete(hostId, deleteCredential)
  // Attach before the timeout race so even late success clears durable and session recovery ids.
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
    // Timeout releases deduplication for a user retry without starting more work.
    inflightDeletes.delete(hostId)
  }

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

export async function cancelPendingHostCredentialCleanup(hostId: string): Promise<void> {
  clearUnrecordedPending(hostId)
  await removePendingId(hostId)
}

// Persist cleanup intent before nonblocking keychain deletion; fall back to a session recovery id if intent storage fails.
export async function scheduleHostCredentialCleanup(
  hostId: string,
  deleteCredential: DeleteHostCredential,
  timeoutMs = CLEANUP_CONFIRM_TIMEOUT_MS
): Promise<void> {
  const recorded = await recordCleanupIntent(hostId)
  if (!recorded) {
    // Preserve recovery in memory when durable intent fails; keep removal nonblocking.
    markUnrecordedPending(hostId)
  }
  void confirmNativeCleanup(hostId, deleteCredential, timeoutMs).catch(() => {})
}

export async function retryPendingHostCredentialCleanups(
  deleteCredential: DeleteHostCredential
): Promise<{ clearedCount: number; remainingIds: string[]; storageUnreadable: boolean }> {
  const pending = await loadPendingCleanupState()
  const outcomes = await Promise.all(
    // Do not re-add existing intent: a late successful delete could otherwise be followed by a ghost recovery row.
    pending.ids.map((id) => confirmNativeCleanup(id, deleteCredential, CLEANUP_CONFIRM_TIMEOUT_MS))
  )
  const remaining = await loadPendingCleanupState()
  return {
    clearedCount: outcomes.filter((outcome) => outcome === 'cleared').length,
    remainingIds: remaining.ids,
    storageUnreadable: remaining.storageUnreadable
  }
}

export function resetHostCredentialCleanupForTests(): void {
  inflightDeletes.clear()
  pendingListeners.clear()
  unrecordedPendingIds.clear()
  pendingMutation = Promise.resolve()
}
