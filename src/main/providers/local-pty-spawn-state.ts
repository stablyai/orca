import type { PtySpawnResult } from './types'
import {
  pendingLocalPtySpawns,
  ptyIncarnations,
  ptyProcesses,
  ptyWslDistroById,
  type PendingLocalPtySpawn
} from './local-pty-provider-state'

const spawnReservations = new Map<string, Promise<unknown>>()

/** A Windows shell receipt can arrive after another request reaches the same native spawn. */
export async function reserveLocalPtySpawn<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = spawnReservations.get(id)
  const pending = previous ? previous.catch(() => {}).then(operation) : operation()
  spawnReservations.set(id, pending)
  try {
    return await pending
  } finally {
    if (spawnReservations.get(id) === pending) {
      spawnReservations.delete(id)
    }
  }
}

/** Keep shutdown visible between awaits until the native process is registered. */
export async function runCancelableLocalPtySpawn<T>(
  id: string,
  operation: (throwIfCanceled: () => void, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const cancellation = new AbortController()
  const pendingSpawn: PendingLocalPtySpawn = { cancellation }
  const pending = pendingLocalPtySpawns.get(id) ?? new Set()
  pending.add(pendingSpawn)
  pendingLocalPtySpawns.set(id, pending)
  try {
    return await operation(() => cancellation.signal.throwIfAborted(), cancellation.signal)
  } finally {
    pending.delete(pendingSpawn)
    if (pending.size === 0) {
      pendingLocalPtySpawns.delete(id)
    }
  }
}

export function cancelPendingLocalPtySpawns(id: string): void {
  const pending = pendingLocalPtySpawns.get(id)
  if (!pending) {
    return
  }
  for (const pendingSpawn of pending) {
    pendingSpawn.cancellation.abort(new Error(`PTY spawn canceled: ${id}`))
  }
}

export function cancelAllPendingLocalPtySpawns(): void {
  for (const id of pendingLocalPtySpawns.keys()) {
    cancelPendingLocalPtySpawns(id)
  }
}

export function reattachLocalPty(id: string, cols: number, rows: number): PtySpawnResult | null {
  const existing = ptyProcesses.get(id)
  if (!existing) {
    return null
  }
  let resized = false
  try {
    existing.resize(cols, rows)
    resized = true
  } catch {
    /* Existing PTY may reject resize during teardown; still return the live handle. */
  }
  return {
    id,
    ...(ptyIncarnations.has(id) ? { incarnationId: ptyIncarnations.get(id) } : {}),
    pid: existing.pid,
    ...(ptyWslDistroById.has(id) ? { wslDistro: ptyWslDistroById.get(id) ?? null } : {}),
    isReattach: true,
    // Why: unlike daemon/relay attach, this one really moved the live PTY to the caller's grid.
    ...(resized ? { attachedGrid: { cols, rows } } : {})
  }
}
