import { ipcMain } from 'electron'
import type { ConnectCurrentOrcaProfileResult } from '../../shared/orca-profiles'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { connectCurrentOrcaProfile } from '../orca-profiles/profile-cloud-service'

/** Registers the connect/cancel sign-in IPC; a cancel only reaches the requesting window's flow. */
export function registerOrcaProfileSignInHandlers(options: { onAuthMutation?: () => void }): void {
  // Why keyed by sender: the dashboard popout runs its own renderer store, so a
  // Cancel there must not abort a sign-in the main window is waiting on.
  const pendingConnects = new Map<number, AbortController>()

  ipcMain.handle(
    'orcaProfiles:connectCurrent',
    async (event): Promise<ConnectCurrentOrcaProfileResult> => {
      const controller = new AbortController()
      pendingConnects.set(event.sender.id, controller)
      try {
        const result = await connectCurrentOrcaProfile(getProfileUserDataPath(), {
          signal: controller.signal
        })
        if (result.status === 'connected') {
          options.onAuthMutation?.()
        }
        return result
      } finally {
        if (pendingConnects.get(event.sender.id) === controller) {
          pendingConnects.delete(event.sender.id)
        }
      }
    }
  )

  ipcMain.handle('orcaProfiles:cancelConnect', (event): void => {
    pendingConnects.get(event.sender.id)?.abort()
  })
}
