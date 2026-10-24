import { app, BrowserWindow } from 'electron'
import type { UIZoomDirection } from '../../shared/ui-zoom-level'
import { ensureMainI18n, setMainUiLanguage } from '../i18n/main-i18n'
import {
  registerAppMenu,
  rebuildAppMenu,
  getNextDefaultOnAppearanceSettingValue
} from '../menu/register-app-menu'
import { zoomDashboardPopoutIfFocused } from '../window/dashboard-popout-window'
import { zoomWorkspaceSpaceWindowIfFocused } from '../window/workspace-space-window'
import { preferredDesktopRenderer } from '../window/desktop-renderer-registry'
import { openRuntimeClientWindowFromUserCommand } from '../window/runtime-client-window-open-command'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { mainProcessState as state } from './main-process-state'
import {
  openSettingsFromSystemMenu,
  quitFromUserCommand,
  runUserInitiatedUpdateCheck,
  sendOpenCrashReport,
  sendOpenFeatureTour,
  sendOpenSetupGuide
} from './main-window-actions'
import { ensureAutoUpdaterConfigured } from '../window/attach-main-window-services'
import { logStartupMilestone } from './startup-diagnostics'

// Auxiliary windows handle zoom directly; full desktop windows use their renderer.
function zoomFocusedWindowFromMenu(direction: UIZoomDirection): void {
  if (!zoomDashboardPopoutIfFocused(direction) && !zoomWorkspaceSpaceWindowIfFocused(direction)) {
    preferredDesktopRenderer()?.send('terminal:zoom', direction)
  }
}

function sendToFocusedDesktopRenderer(channel: string): void {
  preferredDesktopRenderer()?.send(channel)
}

export async function initializeMainProcessI18nAndMenu(): Promise<void> {
  const store = state.store
  if (!store) {
    throw new Error('Store must be initialized before menu')
  }
  await ensureMainI18n()
  await setMainUiLanguage(store.getSettings().uiLanguage)
  logStartupMilestone('i18n-ready')
  registerAppMenu({
    appMenuLabel: state.devInstanceIdentity?.name ?? app.name,
    ...(state.isServeMode ? { onQuit: quitFromUserCommand } : {}),
    onCheckForUpdates: (options) => {
      ensureAutoUpdaterConfigured()
      runUserInitiatedUpdateCheck(options)
    },
    onBeforeReload: ({ ignoreCache, webContentsId }) => {
      if (state.mainWindow?.webContents.id === webContentsId) {
        state.expectedRendererReload.mark(webContentsId)
      }
      recordCrashBreadcrumb('manual_reload_requested', { ignoreCache })
    },
    onOpenSettings: openSettingsFromSystemMenu,
    onNewWindow: openRuntimeClientWindowFromUserCommand,
    onOpenSetupGuide: (targetWindow) => {
      recordCrashBreadcrumb('setup_guide_opened')
      sendOpenSetupGuide(targetWindow instanceof BrowserWindow ? targetWindow : null)
    },
    onOpenCrashReport: (targetWindow) => {
      recordCrashBreadcrumb('crash_report_opened')
      sendOpenCrashReport(targetWindow instanceof BrowserWindow ? targetWindow : null)
    },
    onOpenFeatureTour: (targetWindow) => {
      recordCrashBreadcrumb('feature_tour_opened')
      // Why: use the invoking BrowserWindow so hidden/E2E and multi-window flows route to the right renderer, not global focus.
      sendOpenFeatureTour(targetWindow instanceof BrowserWindow ? targetWindow : null)
    },
    onZoomIn: () => zoomFocusedWindowFromMenu('in'),
    onZoomOut: () => zoomFocusedWindowFromMenu('out'),
    onZoomReset: () => zoomFocusedWindowFromMenu('reset'),
    onToggleLeftSidebar: () => sendToFocusedDesktopRenderer('ui:toggleLeftSidebar'),
    onToggleRightSidebar: () => sendToFocusedDesktopRenderer('ui:toggleRightSidebar'),
    onToggleAppearance: (key) => {
      if (key === 'statusBarVisible') {
        // Why: status bar visibility lives in persisted UI state (not settings) and the renderer owns the toggle — forward the event, let it flip + store.
        sendToFocusedDesktopRenderer('ui:toggleStatusBar')
        return
      }
      const current = store.getSettings()
      // Why: these appearance settings are default-on, so a missing persisted value must toggle from visible -> hidden.
      const next = getNextDefaultOnAppearanceSettingValue(current[key])
      store.updateSettings({ [key]: next }, { notifyListeners: true })
      rebuildAppMenu()
    },
    getAppearanceState: () => {
      const settings = store.getSettings()
      const ui = store.getUI()
      return {
        showTasksButton: settings.showTasksButton !== false,
        showAutomationsButton: settings.showAutomationsButton !== false,
        showMobileButton: settings.showMobileButton !== false,
        showTitlebarAppName: settings.showTitlebarAppName !== false,
        statusBarVisible: ui.statusBarVisible !== false
      }
    },
    getKeybindings: () => state.keybindings?.getOverrides()
  })
}
