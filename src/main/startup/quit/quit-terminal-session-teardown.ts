import type { TerminalQuitSessionSettings } from '../../../shared/terminal/pty/lifecycle/terminal-quit-session-settings'
import { isAppRelaunchRequested } from './app-relaunch'
import { disconnectDaemon } from '../../daemon/providers/lifecycle/daemon-provider-state'
import { killAllDaemonSessions } from '../../ipc/pty/pty-management'
import { settleWithinMs } from './quit-teardown-deadline'

// Leaves the will-quit deadline room for the final save before and the disconnect after.
const STOP_SESSIONS_BUDGET_MS = 10_000

// Why after the final save: exits from the killed sessions must not persist closed tabs, so next launch reopens them.
async function stopTerminalSessionsThenDisconnect(
  finalSaveFrozen: Promise<boolean>
): Promise<void> {
  if (!(await finalSaveFrozen)) {
    // Unfrozen writes could persist closed tabs, and live sessions are the only recovery source left.
    console.warn('[shutdown] Final save did not complete; keeping terminal sessions')
    await disconnectDaemon()
    return
  }
  const stop = await settleWithinMs(killAllDaemonSessions(), STOP_SESSIONS_BUDGET_MS)
  if (stop.outcome === 'failed') {
    console.error('[shutdown] Failed to stop terminal sessions on quit:', stop.error)
  } else if (
    stop.outcome === 'timed-out' ||
    stop.value.remainingCount > 0 ||
    stop.value.listingIncomplete
  ) {
    console.warn('[shutdown] Some terminal sessions may outlive quit', {
      timedOut: stop.outcome === 'timed-out',
      remainingCount: stop.outcome === 'settled' ? stop.value.remainingCount : null,
      listingIncomplete: stop.outcome === 'settled' && stop.value.listingIncomplete === true
    })
  }
  await disconnectDaemon()
}

/** Normal quits keep sessions for warm reattach; the opt-in setting stops them unless the quit is a restart. */
export function disconnectDaemonOnQuit(options: {
  settings: TerminalQuitSessionSettings | undefined
  isUpdateQuit: boolean
  isServeMode: boolean
  finalSaveFrozen: Promise<boolean>
}): Promise<void> {
  const stopSessions =
    options.settings?.stopTerminalSessionsOnQuit === true &&
    !options.isUpdateQuit &&
    !options.isServeMode &&
    !isAppRelaunchRequested()
  return stopSessions
    ? stopTerminalSessionsThenDisconnect(options.finalSaveFrozen)
    : disconnectDaemon()
}
