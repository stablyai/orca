/**
 * A WSL bridge pane's process exit, when its whole distro is gone (`wsl --terminate`, a shutdown
 * or a crash), is host loss, not the shell exiting: like a daemon crash, the pane keeps its tab
 * and history and cold-restores later. `wsl.exe` reports such an exit as an ordinary code (1),
 * so only the running list tells it from a shell's own `exit`.
 */
import {
  readConfirmedRunningWslDistros,
  type WslRunningDistrosRead
} from '../wsl-background-distro-gate'

/** The code a synthetic host-loss exit carries, as after a daemon crash. */
export const WSL_DISTRO_LOSS_EXIT_CODE = -1

// Every bridge exit, a user's own `exit` too, waits on this before its tab reacts: keep it short.
const WSL_EXIT_CHECK_TIMEOUT_MS = 3_000

export type ReadRunningWslDistros = (options: {
  startedAfter?: number
}) => Promise<WslRunningDistrosRead>

/**
 * True only when a running list confirmed after the exit lacks the distro. The probe is the shared,
 * coalesced `wsl --list --running` (it never boots): a terminate that exits many panes costs one
 * spawn, and a probe already in flight from before the exit (which may predate the distro's boot)
 * gets one fresh probe after it. Unavailable or late means unchanged: the exit stays an exit.
 */
export async function isWslBridgeDistroLost(
  distro: string,
  exitAt: number,
  readRunning: ReadRunningWslDistros = readConfirmedRunningWslDistros,
  timeoutMs = WSL_EXIT_CHECK_TIMEOUT_MS
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<WslRunningDistrosRead>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'unavailable' }), timeoutMs)
  })
  try {
    const running = await Promise.race([
      readRunning({ startedAfter: exitAt }).catch((): WslRunningDistrosRead => ({
        status: 'unavailable'
      })),
      timedOut
    ])
    const key = distro.trim().toLowerCase()
    return (
      running.status === 'confirmed' &&
      !running.distros.some((candidate) => candidate.trim().toLowerCase() === key)
    )
  } finally {
    clearTimeout(timer)
  }
}
