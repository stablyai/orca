import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { getTrustedUIRendererWindow } from '../../ipc/ui'
import type { NativeSettingsProjection } from '../../core-desktop/native-settings-projection'
import { logStartupMilestone } from '../../startup/diagnostics/startup-diagnostics'
import { normalizeUpdateDelayDays } from '../../../shared/updater/update-delay'
import {
  getActiveTeamCapabilities,
  getActiveTeamProfileScope,
  onTeamCapabilitiesInvalidated
} from '../../orca-profiles/cloud-auth/active-team-capabilities'
import { getOrcaProfileDirectory } from '../../orca-profiles/profile-storage-paths'
import { loadUpdaterService } from '../updater-service-slot'
import type { PreQuitCleanupFailureMode, UpdateInstallMode } from './updater-state'
import type { UpdaterSetupOptions } from './updater-setup'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { hasWorkingUpdateAgents } from './update-agent-activity'
import type {
  getEmergencyUpdateFloor,
  watchEmergencyUpdateFloor
} from '../releases/updater-emergency-policy'
import type { applyEmergencyUpdateFloor } from '../releases/updater-release-policy'

const UPDATER_SETUP_FALLBACK_MS = 15_000

// Manual checks may precede deferred setup; entry points must configure first.
let pendingAutoUpdaterSetup: (() => Promise<void>) | null = null

export function ensureAutoUpdaterConfigured(): Promise<void> {
  return pendingAutoUpdaterSetup ? pendingAutoUpdaterSetup() : Promise.resolve()
}

type UpdaterSetupHooks = {
  onBeforeUpdateQuit?: () => void | Promise<void>
  onBeforeUpdateQuitFailure?: PreQuitCleanupFailureMode
  updateInstallMode?: UpdateInstallMode
  isServeMode?: boolean
  hasWorkingAgents?: () => boolean
}

type UpdaterPolicyModule = {
  applyEmergencyUpdateFloor: typeof applyEmergencyUpdateFloor
  getEmergencyUpdateFloor: typeof getEmergencyUpdateFloor
  watchEmergencyUpdateFloor: typeof watchEmergencyUpdateFloor
}

function buildUpdaterSetupOptions(
  nativeSettings: NativeSettingsProjection,
  policy: UpdaterPolicyModule,
  options?: UpdaterSetupHooks
): UpdaterSetupOptions {
  return {
    getMainWindow: getTrustedUIRendererWindow,
    getLastUpdateCheckAt: () => nativeSettings.getUI().lastUpdateCheckAt,
    onBeforeQuit: async () => {
      try {
        await options?.onBeforeUpdateQuit?.()
      } finally {
        await nativeSettings.requestCoreWrite({ kind: 'flush-pending' })
      }
    },
    setLastUpdateCheckAt: (timestamp) => {
      void nativeSettings.requestCoreWrite({
        kind: 'ui',
        updates: { lastUpdateCheckAt: timestamp }
      })
    },
    getPendingUpdateNudgeId: () => nativeSettings.getUI().pendingUpdateNudgeId ?? null,
    getDismissedUpdateNudgeId: () => nativeSettings.getUI().dismissedUpdateNudgeId ?? null,
    setPendingUpdateNudgeId: (id) => {
      // Applying a new campaign clears the hidden card; clearing a campaign must preserve dismissal.
      if (id) {
        void nativeSettings.requestCoreWrite({
          kind: 'ui',
          updates: { pendingUpdateNudgeId: id, dismissedUpdateVersion: null }
        })
      } else {
        void nativeSettings.requestCoreWrite({
          kind: 'ui',
          updates: { pendingUpdateNudgeId: null }
        })
      }
    },
    setDismissedUpdateNudgeId: (id) => {
      void nativeSettings.requestCoreWrite({ kind: 'ui', updates: { dismissedUpdateNudgeId: id } })
    },
    getReleaseChannelOverride: () => nativeSettings.getUI().releaseChannelOverride ?? null,
    getTeamUpdatePolicy: () =>
      policy.applyEmergencyUpdateFloor(
        getActiveTeamCapabilities()?.teamPolicy,
        policy.getEmergencyUpdateFloor(),
        app.getVersion()
      ),
    onTeamUpdatePolicyChanged: (listener) => {
      const syncEmergencyFloor = policy.watchEmergencyUpdateFloor(listener)
      const syncPolicies = (): void => {
        syncEmergencyFloor(getActiveTeamCapabilities() !== undefined)
        listener()
      }
      const unsubscribe = onTeamCapabilitiesInvalidated(syncPolicies)
      syncPolicies()
      app.once('will-quit', () => {
        unsubscribe()
        syncEmergencyFloor(false)
      })
    },
    teamRestart: {
      scope: () => {
        const scope = getActiveTeamProfileScope()
        return (
          scope && {
            file: join(
              getOrcaProfileDirectory(scope.profileId, scope.root),
              'required-orca-update.json'
            ),
            accountId: scope.userId
          }
        )
      },
      hasWorkingAgents: options?.hasWorkingAgents ?? (() => false)
    },
    getUpdateDelayDays: () =>
      normalizeUpdateDelayDays(nativeSettings.getSettings().updateDelayDays),
    getAutomaticUpdates: () => nativeSettings.getSettings().automaticUpdates === true,
    onBeforeQuitFailure: options?.onBeforeUpdateQuitFailure,
    installMode: options?.updateInstallMode
  }
}

async function setupAutoUpdaterWithAppProxy(
  mainWindow: BrowserWindow | null,
  nativeSettings: NativeSettingsProjection,
  options?: UpdaterSetupHooks
): Promise<void> {
  const [
    updaterService,
    { applyProxyToElectronUpdaterSession },
    { getEmergencyUpdateFloor, watchEmergencyUpdateFloor },
    { applyEmergencyUpdateFloor }
  ] = await Promise.all([
    loadUpdaterService(),
    import('./electron-updater-proxy-session'),
    import('../releases/updater-emergency-policy'),
    import('../releases/updater-release-policy')
  ])
  if (mainWindow?.isDestroyed()) {
    return
  }
  // Starts synchronously before setupAutoUpdater, so the session request guard holds the first update check until it settles.
  void applyProxyToElectronUpdaterSession(nativeSettings.getSettings())
  updaterService.setupAutoUpdater(
    mainWindow,
    buildUpdaterSetupOptions(
      nativeSettings,
      { applyEmergencyUpdateFloor, getEmergencyUpdateFloor, watchEmergencyUpdateFloor },
      {
        ...options,
        updateInstallMode:
          options?.updateInstallMode ??
          (options?.isServeMode !== undefined
            ? updaterService.resolveUpdateInstallMode(options.isServeMode)
            : undefined)
      }
    )
  )
}

/** Headless serve has no window-driven setup; defer the slow require past readiness so remote updater support becomes available (#22261). */
export function setupHeadlessServeAutoUpdater(
  nativeSettings: NativeSettingsProjection,
  runtime: Pick<OrcaRuntimeService, 'getAgentStatusSnapshotFn'>,
  options: UpdaterSetupHooks
): void {
  setImmediate(() => {
    void setupAutoUpdaterWithAppProxy(null, nativeSettings, {
      ...options,
      hasWorkingAgents: () => hasWorkingUpdateAgents(runtime.getAgentStatusSnapshotFn?.() ?? [])
    })
      .then(() => {
        logStartupMilestone('updater-setup-done')
      })
      .catch((error: unknown) => {
        console.warn(
          '[serve] updater setup failed:',
          error instanceof Error ? error.message : String(error)
        )
      })
  })
}

export function scheduleMainWindowAutoUpdaterSetup(
  mainWindow: BrowserWindow,
  nativeSettings: NativeSettingsProjection,
  options?: UpdaterSetupHooks
): void {
  // Cold Windows/Defender makes electron-updater require slow (#7225); defer past paint, with a timer for crash-looping renderers.
  let updaterSetupPromise: Promise<void> | null = null
  let updaterSetupFallback: ReturnType<typeof setTimeout> | null = null
  const clearDeferredSetup = (): void => {
    if (updaterSetupFallback) {
      clearTimeout(updaterSetupFallback)
      updaterSetupFallback = null
    }
    if (pendingAutoUpdaterSetup === setupAutoUpdaterDeferred) {
      pendingAutoUpdaterSetup = null
    }
  }
  const setupAutoUpdaterDeferred = (): Promise<void> => {
    if (updaterSetupPromise) {
      return updaterSetupPromise
    }
    if (mainWindow.isDestroyed()) {
      clearDeferredSetup()
      return Promise.resolve()
    }
    updaterSetupPromise = setupAutoUpdaterWithAppProxy(mainWindow, nativeSettings, options)
      .then(() => {
        logStartupMilestone('updater-setup-done')
      })
      .finally(() => {
        clearDeferredSetup()
      })
    return updaterSetupPromise
  }
  pendingAutoUpdaterSetup = setupAutoUpdaterDeferred
  mainWindow.once('ready-to-show', () =>
    setImmediate(() => {
      void setupAutoUpdaterDeferred().catch((error: unknown) => {
        console.warn('[updater] deferred setup failed:', error)
      })
    })
  )
  updaterSetupFallback = setTimeout(() => {
    updaterSetupFallback = null
    void setupAutoUpdaterDeferred().catch((error: unknown) => {
      console.warn('[updater] fallback setup failed:', error)
    })
  }, UPDATER_SETUP_FALLBACK_MS)
  updaterSetupFallback.unref?.()
  if (updaterSetupPromise) {
    clearDeferredSetup()
  }
}
