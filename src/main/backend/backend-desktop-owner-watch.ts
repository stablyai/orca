import { readFile, readlink } from 'node:fs/promises'
import { parseLinuxStartTicks } from '../agent-hooks/installation/locking/managed-hook-owner-identity'
import type { BackendDesktopOwner } from '../../shared/backend/backend-service-contract'

export const DESKTOP_OWNER_POLL_MS = 2_000

let ownIdentity: Promise<BackendDesktopOwner | undefined> | undefined

/** Main's identity, so a Linux backend can tell main's death from a reused pid. */
export function readDesktopOwnerIdentity(): Promise<BackendDesktopOwner | undefined> {
  ownIdentity ??=
    process.platform !== 'linux'
      ? Promise.resolve(undefined)
      : Promise.all([readFile('/proc/self/stat', 'utf8'), readlink('/proc/self/ns/pid')])
          .then(([stat, pidNamespace]) => {
            const startTicks = parseLinuxStartTicks(stat)
            return startTicks ? { pid: process.pid, startTicks, pidNamespace } : undefined
          })
          .catch(() => undefined)
  return ownIdentity
}

/**
 * Linux: if another process keeps main's end of this utility's IPC socket open, main's death goes
 * unseen, so the backend outlives it holding the service lock and the next launch can't start.
 */
export async function watchDesktopOwner(
  owner: BackendDesktopOwner | undefined,
  onGone: () => void
): Promise<void> {
  if (process.platform !== 'linux') {
    return
  }
  const ownNamespace = await readlink('/proc/self/ns/pid').catch(() => null)
  if (!owner || ownNamespace !== owner.pidNamespace) {
    // Main's pid means nothing here; a wrong guess would stop a healthy backend.
    console.warn(`[backend] Can't identify the desktop process; not watching it.`)
    return
  }
  // Awaited so a desktop that already died stops the backend before it takes the lock.
  if (await isGone(owner)) {
    onGone()
    return
  }
  let checking = false
  const check = (): void => {
    if (checking) {
      return
    }
    checking = true
    void isGone(owner)
      .then((gone) => {
        if (gone) {
          clearInterval(timer)
          onGone()
        }
      })
      .finally(() => {
        checking = false
      })
  }
  // Node exposes no exit event for a process it didn't spawn; this stops once main is gone.
  const timer = setInterval(check, DESKTOP_OWNER_POLL_MS)
  timer.unref()
}

/** True only on proof main is gone; an unreadable stat on a live pid never stops the backend. */
async function isGone(owner: BackendDesktopOwner): Promise<boolean> {
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    // EPERM: another user's process may hold the pid now; its start ticks decide.
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return true
    }
  }
  const stat = await readFile(`/proc/${owner.pid}/stat`, 'utf8').catch(() => null)
  if (!stat) {
    return false
  }
  const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
  const startTicks = parseLinuxStartTicks(stat)
  return state === 'Z' || state === 'X' || (startTicks !== null && startTicks !== owner.startTicks)
}
