import { readFileSync } from 'node:fs'
import {
  readOrcadProcessIncarnation,
  type OrcadProcessIncarnation
} from '../orcad/instance-lock/orcad-process-start-time'
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
  const started = readOrcadProcessIncarnation(pid)
  const check = (): boolean => {
    if (!desktopGone(pid, started)) {
      return false
    }
    clearInterval(timer)
    onGone()
    return true
  }
  const timer = setInterval(check, DESKTOP_OWNER_POLL_MS)
  timer.unref()
  check()
}

/** Only proof counts: a read failure on a live pid never stops the backend. */
function desktopGone(pid: number, started: OrcadProcessIncarnation | null): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
    if (state === 'Z' || state === 'X') {
      return true
    }
  } catch {
    return false
  }
  const now = readOrcadProcessIncarnation(pid)
  return Boolean(
    started &&
    now &&
    (now.linuxStartTicks !== started.linuxStartTicks || now.bootId !== started.bootId)
  )
}
