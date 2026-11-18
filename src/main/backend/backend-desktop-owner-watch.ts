import { readFile } from 'node:fs/promises'
import { parseLinuxStartTicks } from '../agent-hooks/installation/locking/managed-hook-owner-identity'
import { BACKEND_DESKTOP_PID_ARG } from '../../shared/backend/backend-service-contract'

export const DESKTOP_OWNER_POLL_MS = 2_000

/**
 * Linux: if another process keeps main's end of this utility's IPC socket open, main's death goes
 * unseen, so the backend outlives it holding the service lock and the next launch can't start.
 */
export function watchDesktopOwner(argv: readonly string[], onGone: () => void): void {
  const pid = Number(
    argv
      .find((arg) => arg.startsWith(BACKEND_DESKTOP_PID_ARG))
      ?.slice(BACKEND_DESKTOP_PID_ARG.length)
  )
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 1) {
    return
  }
  // Main forked this backend, so a process on main's pid that started later is a reused pid.
  const ownStart = readStartTicks('self')
  let checking = false
  let seen = false
  const check = (): void => {
    if (checking) {
      return
    }
    checking = true
    void Promise.all([desktopState(pid), ownStart])
      .then(([state, own]) => {
        const reused = Boolean(state?.startTicks && own && Number(state.startTicks) > Number(own))
        const gone = state === null || reused
        if (gone && !seen) {
          // Main forked this backend moments ago; not seeing it means another pid namespace.
          clearInterval(timer)
          console.warn(`[backend] Can't observe desktop pid ${pid}; not watching it.`)
        } else if (gone) {
          clearInterval(timer)
          onGone()
        }
        seen = true
      })
      .finally(() => {
        checking = false
      })
  }
  // Node exposes no exit event for a process it didn't spawn; this stops once main is gone.
  const timer = setInterval(check, DESKTOP_OWNER_POLL_MS)
  timer.unref()
  check()
}

/** Null only on proof main is gone; an unreadable stat on a live pid never stops the backend. */
async function desktopState(pid: number): Promise<{ startTicks: string | null } | null> {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
      ? null
      : { startTicks: null }
  }
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null)
  const state = stat?.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
  if (state === 'Z' || state === 'X') {
    return null
  }
  return { startTicks: stat ? parseLinuxStartTicks(stat) : null }
}

async function readStartTicks(pid: number | 'self'): Promise<string | null> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null)
  return stat ? parseLinuxStartTicks(stat) : null
}
