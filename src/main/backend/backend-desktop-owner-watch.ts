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
  let started: string | null | undefined
  let checking = false
  const check = (): void => {
    if (checking) {
      return
    }
    checking = true
    void desktopState(pid)
      .then((state) => {
        started ??= state?.startTicks ?? null
        if (state === null || (started && state.startTicks && state.startTicks !== started)) {
          clearInterval(timer)
          onGone()
        }
      })
      .finally(() => {
        checking = false
      })
  }
  // No push signal exists for another process's exit; this stops once main is gone.
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
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
    return state === 'Z' || state === 'X' ? null : { startTicks: parseLinuxStartTicks(stat) }
  } catch {
    return { startTicks: null }
  }
}
