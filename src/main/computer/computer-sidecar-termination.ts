import type { ChildProcess } from 'node:child_process'

export const COMPUTER_SIDECAR_FORCE_KILL_GRACE_MS = 5_000

export function terminateComputerSidecarChild(child: ChildProcess): void {
  let exited = false
  let forceKillTimer: NodeJS.Timeout | null = null
  const onExit = (): void => {
    exited = true
    if (forceKillTimer) {
      clearTimeout(forceKillTimer)
      forceKillTimer = null
    }
  }
  child.once('exit', onExit)
  try {
    child.kill('SIGTERM')
  } catch {}
  if (exited) {
    return
  }
  forceKillTimer = setTimeout(() => {
    forceKillTimer = null
    child.off('exit', onExit)
    try {
      child.kill('SIGKILL')
    } catch {}
  }, COMPUTER_SIDECAR_FORCE_KILL_GRACE_MS)
  forceKillTimer.unref()
}
