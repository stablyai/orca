/**
 * A WSL bridge pane's process exit, when its whole distro is gone (`wsl --terminate`, a shutdown
 * or a crash), is host loss, not the shell exiting: like a daemon crash, the pane keeps its tab
 * and history and cold-restores later. `wsl.exe` reports such an exit as an ordinary code (1),
 * so only the running list, and the distro's boot id when something booted it again first, tells
 * it from a shell's own `exit`.
 */
import {
  readConfirmedRunningWslDistros,
  settledWslRunningReadAnchor,
  type WslRunningDistrosRead
} from '../wsl-background-distro-gate'

/** The code a synthetic host-loss exit carries, as after a daemon crash. */
export const WSL_DISTRO_LOSS_EXIT_CODE = -1

// Every bridge exit, a user's own `exit` too, waits on this before its tab reacts: keep it short.
const WSL_EXIT_CHECK_FIRST_MS = 3_000
// One retry past the failure backoff when the first read can't answer; a wedged wsl.exe costs this.
const WSL_EXIT_CHECK_TOTAL_MS = 10_000

export type ReadRunningWslDistros = (options: {
  startedAfter?: number
  bypassFailureBackoff?: boolean
}) => Promise<WslRunningDistrosRead>

/** What the running list said about the distro after a bridge exit. */
export type WslBridgeExitVerdict = 'lost' | 'running' | 'unavailable'

/**
 * Lost only when a running list confirmed after the exit lacks the distro. The probe is the shared,
 * coalesced `wsl --list --running` (it never boots): a terminate that exits many panes costs one
 * spawn, and a probe already in flight from before the exit (which may predate the distro's boot)
 * gets one fresh probe after it. A read that can't answer is retried once; still unavailable or
 * late means unchanged: the exit stays an exit.
 */
export async function checkWslBridgeDistro(
  distro: string,
  exitAt: number,
  readRunning: ReadRunningWslDistros = readConfirmedRunningWslDistros,
  { firstMs = WSL_EXIT_CHECK_FIRST_MS, totalMs = WSL_EXIT_CHECK_TOTAL_MS } = {}
): Promise<WslBridgeExitVerdict> {
  // WSL keeps listing a stopping distro for a moment; a read inside that window would say 'running'.
  const startedAfter = await settledWslRunningReadAnchor(distro, exitAt)
  const startedAt = performance.now()
  let running = await readWithin(() => readRunning({ startedAfter }), firstMs)
  if (running.status !== 'confirmed') {
    const remainingMs = totalMs - (performance.now() - startedAt)
    running =
      remainingMs > 0
        ? await readWithin(
            () => readRunning({ startedAfter, bypassFailureBackoff: true }),
            remainingMs
          )
        : running
  }
  if (running.status !== 'confirmed') {
    return 'unavailable'
  }
  const key = distro.trim().toLowerCase()
  return running.distros.some((candidate) => candidate.trim().toLowerCase() === key)
    ? 'running'
    : 'lost'
}

async function readWithin(
  read: () => Promise<WslRunningDistrosRead>,
  timeoutMs: number
): Promise<WslRunningDistrosRead> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<WslRunningDistrosRead>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'unavailable' }), timeoutMs)
  })
  try {
    return await Promise.race([
      read().catch((): WslRunningDistrosRead => ({ status: 'unavailable' })),
      timedOut
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The verdict for a bridge exit. A distro that answers 'running' may have been booted again by
 * something else before the list ran; a new boot id since the pane's spawn still makes it loss.
 */
export async function classifyWslBridgeExit(
  distro: string,
  exitAt: number,
  readRunning: ReadRunningWslDistros | undefined,
  rebootedSinceSpawn: () => Promise<boolean>
): Promise<WslBridgeExitVerdict | 'rebooted'> {
  const verdict = await checkWslBridgeDistro(distro, exitAt, readRunning)
  return verdict === 'running' && (await rebootedSinceSpawn()) ? 'rebooted' : verdict
}
