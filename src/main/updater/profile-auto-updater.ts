import type { BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { logStartupMilestone } from '../startup/startup-diagnostics'
import {
  setupAutoUpdater,
  type PreQuitCleanupFailureMode,
  type UpdateInstallMode
} from '../updater'

export type ProfileAutoUpdaterOptions = {
  onBeforeUpdateQuit?: () => void | Promise<void>
  onBeforeUpdateQuitFailure?: PreQuitCleanupFailureMode
  updateInstallMode?: UpdateInstallMode
}

export function configureProfileAutoUpdater(
  mainWindow: BrowserWindow | null,
  store: Store,
  options?: ProfileAutoUpdaterOptions
): void {
  setupAutoUpdater(mainWindow, {
    getLastUpdateCheckAt: () => store.getUI().lastUpdateCheckAt,
    onBeforeQuit: async () => {
      try {
        await options?.onBeforeUpdateQuit?.()
      } finally {
        await store.flushPendingAsync()
      }
    },
    setLastUpdateCheckAt: (timestamp) => {
      store.updateUI({ lastUpdateCheckAt: timestamp })
    },
    getPendingUpdateNudgeId: () => store.getUI().pendingUpdateNudgeId ?? null,
    getDismissedUpdateNudgeId: () => store.getUI().dismissedUpdateNudgeId ?? null,
    setPendingUpdateNudgeId: (id) => {
      // Why: only the apply branch also nulls dismissedUpdateVersion so relaunch can't resurrect the old hidden card; clearing must not, or it un-dismisses.
      if (id) {
        store.updateUI({ pendingUpdateNudgeId: id, dismissedUpdateVersion: null })
      } else {
        store.updateUI({ pendingUpdateNudgeId: null })
      }
    },
    setDismissedUpdateNudgeId: (id) => {
      store.updateUI({ dismissedUpdateNudgeId: id })
    },
    getReleaseChannelOverride: () => store.getUI().releaseChannelOverride ?? null,
    onBeforeQuitFailure: options?.onBeforeUpdateQuitFailure,
    installMode: options?.updateInstallMode
  })
  logStartupMilestone('updater-setup-done')
}
