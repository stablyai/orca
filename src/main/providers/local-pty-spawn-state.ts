import type { PtySpawnResult } from './types'
import {
  pendingLocalPtySpawns,
  ptyProcesses,
  ptyWslDistroById,
  type PendingLocalPtySpawn
} from './local-pty-provider-state'

/** Awaits pre-launch work that shutdown must be able to cancel: no node-pty
 *  process exists yet, so cancellation can only be observed after the await. */
export async function awaitCancelableLocalPtySpawn<T>(
  id: string,
  operation: T | Promise<T>
): Promise<T> {
  const pendingSpawn: PendingLocalPtySpawn = { canceled: false }
  const pending = pendingLocalPtySpawns.get(id) ?? new Set()
  pending.add(pendingSpawn)
  pendingLocalPtySpawns.set(id, pending)
  try {
    const result = await operation
    if (pendingSpawn.canceled) {
      throw new Error(`PTY spawn canceled: ${id}`)
    }
    return result
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
    pendingSpawn.canceled = true
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
  try {
    existing.resize(cols, rows)
  } catch {
    /* Existing PTY may reject resize during teardown; still return the live handle. */
  }
  return {
    id,
    pid: existing.pid,
    ...(ptyWslDistroById.has(id) ? { wslDistro: ptyWslDistroById.get(id) ?? null } : {}),
    isReattach: true
  }
}
