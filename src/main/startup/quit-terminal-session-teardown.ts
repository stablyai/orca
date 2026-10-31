import type { GlobalSettings } from '../../shared/global-settings-types'
import { isAppRelaunchRequested } from '../app-relaunch'
import { disconnectDaemon } from '../daemon/daemon-provider-state'
import { killAllDaemonSessions } from '../ipc/pty/pty-management'

// Why after the final save: exits from the killed sessions must not persist closed tabs, so next launch reopens them.
async function stopTerminalSessionsThenDisconnect(finalSave: Promise<void>): Promise<void> {
  await finalSave
  try {
    const { remainingCount, listingIncomplete } = await killAllDaemonSessions()
    if (remainingCount > 0 || listingIncomplete) {
      console.warn('[shutdown] Some terminal sessions may outlive quit', {
        remainingCount,
        listingIncomplete: listingIncomplete === true
      })
    }
  } catch (error) {
    console.error('[shutdown] Failed to stop terminal sessions on quit:', error)
  }
  await disconnectDaemon()
}

/** Normal quits keep sessions for warm reattach; the opt-in setting stops them unless the quit is a restart. */
export function disconnectDaemonOnQuit(options: {
  settings: Pick<GlobalSettings, 'stopTerminalSessionsOnQuit'> | undefined
  isUpdateQuit: boolean
  isServeMode: boolean
  finalSave: Promise<void>
}): Promise<void> {
  const stopSessions =
    options.settings?.stopTerminalSessionsOnQuit === true &&
    !options.isUpdateQuit &&
    !options.isServeMode &&
    !isAppRelaunchRequested()
  return stopSessions ? stopTerminalSessionsThenDisconnect(options.finalSave) : disconnectDaemon()
}
