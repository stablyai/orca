/**
 * The WSL mover's part of main-process startup: registers the desktop rewrite stores, resets or
 * finishes interrupted moves, then keeps retained rows marked and retries a failed host step.
 */
import type { Store } from '../../loading-store/store'
import { recoverInterruptedWslMoves } from '../cutover-recovery/wsl-move-reset'
import { isWslDistroRegistered } from '../../../wsl/discovery/wsl-distro-registry-id'
import { runWslMoveStartupRewrite } from './wsl-move-startup-rewrite'
import { installWslMoveRetention } from '../cutover-recovery/wsl-move-retention'
import { registerWslMoveDesktopRewriteRegistry } from '../desktop-state/wsl-move-desktop-rewrite-registry'
import { disableLocalAutomationsOfEarlierWslMoves } from '../desktop-state/wsl-move-local-automations-rewrite'
import { sweepOrphanedWslMoveSleptSpools } from '../terminal-state/wsl-move-slept-spool-sweep'
import { settleInterruptedWslMoveUndos } from '../cutover-recovery/wsl-move-undo-host-automations'
import { enableWslHostAutomations } from '../../../wsl/host-lifecycle/wsl-host-automation-enable'
import {
  scheduleWslMoveRewriteRetry,
  setWslMoveHostAutomationRestorer
} from '../cutover-recovery/wsl-move-rewrite-retry'
import {
  disableWslHostAutomations,
  restoreWslHostAutomations
} from '../../../wsl/host-lifecycle/wsl-host-automation-disable'
import { orchestrationDbFile } from '../../../runtime/orchestration/db/orchestration-db-file'
import { productionWslMoveBrowserCookieCopyDependencies } from '../desktop-state/wsl-move-browser-cookie-store'

/** Resolves once interrupted moves are reset or finished; main-process-ready waits on it, bounded. */
export function startWslMoveStartup(userDataPath: string, store: Store): Promise<void> {
  setWslMoveHostAutomationRestorer({
    restore: (environmentId, ids, signal) =>
      restoreWslHostAutomations(userDataPath, environmentId, ids, signal),
    disable: (environmentId, ids, signal) =>
      disableWslHostAutomations(userDataPath, environmentId, ids, signal)
  })
  registerWslMoveDesktopRewriteRegistry({
    userDataPath,
    profile: store,
    orchestrationDatabasePath: orchestrationDbFile(userDataPath),
    hostAutomations: {
      enable: (environmentId, ids, signal) =>
        enableWslHostAutomations(userDataPath, environmentId, ids, signal)
    },
    browserCookies: productionWslMoveBrowserCookieCopyDependencies(userDataPath)
  })
  // Resets a move interrupted before commit, then finishes one that committed. Gated off,
  // neither runs.
  const ready = runWslMoveStartupRewrite(
    { userDataPath },
    {
      recover: async () => {
        await recoverInterruptedWslMoves(userDataPath, undefined, (distro, distroGuid) =>
          isWslDistroRegistered(distro, distroGuid)
        )
        sweepOrphanedWslMoveSleptSpools(userDataPath)
        settleInterruptedWslMoveUndos(userDataPath)
        // Best-effort: a copy left on here only skips its runs, as before this catch-up existed.
        await disableLocalAutomationsOfEarlierWslMoves(userDataPath, store).catch((error) => {
          console.warn('[wsl-move] Could not turn off moved automations here:', error)
        })
      }
    }
  )
  // Re-marks retained rows a downgrade stripped; never awaited, since nothing it writes gates a read.
  void ready.then(() => {
    installWslMoveRetention({ userDataPath, store })
    // A committed move's host step (automations back on) that failed retries until it lands.
    scheduleWslMoveRewriteRetry(userDataPath)
  })
  return ready
}
