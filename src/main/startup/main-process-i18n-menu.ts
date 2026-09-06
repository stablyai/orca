import { app, BrowserWindow } from 'electron'
import { ensureMainI18n, setMainUiLanguage } from '../i18n/main-i18n'
import {
  registerAppMenu,
  rebuildAppMenu,
  getNextDefaultOnAppearanceSettingValue
} from '../menu/register-app-menu'
import { zoomDashboardPopoutIfFocused } from '../window/dashboard-popout-window'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { mainProcessState as state } from './main-process-state'
import {
  openSettingsFromSystemMenu,
  runUserInitiatedUpdateCheck,
  sendOpenCrashReport,
  sendOpenFeatureTour,
  sendOpenSetupGuide
} from './main-window-actions'
import { ensureAutoUpdaterConfigured } from '../window/attach-main-window-services'
import { logStartupMilestone } from './startup-diagnostics'

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
    // Why: menu zoom must act on the window the user is looking at — routing to
    // the main window while the dashboard pop-out is focused zooms behind it.
    onZoomIn: () => {
      if (!zoomDashboardPopoutIfFocused('in')) {
        state.mainWindow?.webContents.send('terminal:zoom', 'in')
      }
    },
    onZoomOut: () => {
      if (!zoomDashboardPopoutIfFocused('out')) {
        state.mainWindow?.webContents.send('terminal:zoom', 'out')
      }
    },
    onZoomReset: () => {
      if (!zoomDashboardPopoutIfFocused('reset')) {
        state.mainWindow?.webContents.send('terminal:zoom', 'reset')
      }
    },
    onToggleLeftSidebar: () => state.mainWindow?.webContents.send('ui:toggleLeftSidebar'),
    onToggleRightSidebar: () => state.mainWindow?.webContents.send('ui:toggleRightSidebar'),
    onToggleAppearance: (key) => {
      if (key === 'statusBarVisible') {
        // Why: status bar visibility lives in persisted UI state (not settings) and the renderer owns the toggle — forward the event, let it flip + store.
        state.mainWindow?.webContents.send('ui:toggleStatusBar')
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
