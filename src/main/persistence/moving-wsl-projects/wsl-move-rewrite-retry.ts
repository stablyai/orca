/**
 * Retries the desktop rewrite pass while a committed move still has steps left, such as automations
 * the host could not turn back on yet. A pass runs at startup and after each move; this covers the
 * host coming back later in the same run. Backs off, and stops once nothing is left.
 */
import { wslHostsServing } from '../../wsl/wsl-host-gate'
import { listWslMoveCutovers } from './wsl-move-cutover-journal'
import { runWslMoveDesktopRewritePass } from './wsl-move-desktop-rewrite'
import { pendingWslMoveDesktopRewriteStores } from './wsl-move-desktop-rewrite-stores'
import {
  retryWslMoveHostAutomationsLeftOff,
  type WslMoveHostAutomationRetryHost
} from './wsl-move-undo-host-automations'

export const WSL_MOVE_REWRITE_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000]

let timer: ReturnType<typeof setTimeout> | null = null
let restoreHostAutomations: WslMoveHostAutomationRetryHost | null = null

/** How a retry turns back on host automations a refused undo left off (main wires the host). */
export function setWslMoveHostAutomationRestorer(host: WslMoveHostAutomationRetryHost): void {
  restoreHostAutomations = host
}

function hasUnfinishedMove(userDataPath: string): boolean {
  try {
    // Main-side steps only: renderer stores run on the window's next load, not on a timer.
    return listWslMoveCutovers(userDataPath).some(
      (cutover) =>
        (cutover.phase === 'destination-committed' &&
          pendingWslMoveDesktopRewriteStores(cutover.rewrittenStores).some(
            (store) => store.side === 'main'
          )) ||
        (restoreHostAutomations !== null && (cutover.hostAutomationsLeftOff?.length ?? 0) > 0)
    )
  } catch {
    // Unreadable: the pass cannot advance anything either; startup tries again.
    return false
  }
}

/** Idempotent: a retry already waiting keeps its place. No-op with the gate closed. */
export function scheduleWslMoveRewriteRetry(
  userDataPath: string,
  delaysMs: readonly number[] = WSL_MOVE_REWRITE_RETRY_DELAYS_MS,
  attempt = 0
): void {
  if (timer || !wslHostsServing() || !hasUnfinishedMove(userDataPath)) {
    return
  }
  const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 0
  timer = setTimeout(() => {
    timer = null
    void runWslMoveDesktopRewritePass({ userDataPath })
      .then(() =>
        restoreHostAutomations
          ? retryWslMoveHostAutomationsLeftOff(userDataPath, restoreHostAutomations)
          : false
      )
      .catch(() => false)
      .then(() => scheduleWslMoveRewriteRetry(userDataPath, delaysMs, attempt + 1))
  }, delay)
  timer.unref?.()
}

export function cancelWslMoveRewriteRetryForTests(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
