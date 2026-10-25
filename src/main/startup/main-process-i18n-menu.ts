import { app, BrowserWindow } from 'electron'
import { ensureMainI18n, setMainUiLanguage } from '../i18n/main-i18n'
import {
  registerAppMenu,
  rebuildAppMenu,
  getNextDefaultOnAppearanceSettingValue
} from '../menu/register-app-menu'
import { zoomDashboardPopoutIfFocused } from '../window/dashboard-popout-window'
import { zoomWorkspaceSpaceWindowIfFocused } from '../window/workspace-space-window'
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
      // Route to the invoking renderer so hidden tests/multiple windows do not depend on global focus.
      sendOpenFeatureTour(targetWindow instanceof BrowserWindow ? targetWindow : null)
    },
    // Zoom the focused popout rather than changing the main window behind it.
    onZoomIn: () => {
      if (!zoomDashboardPopoutIfFocused('in') && !zoomWorkspaceSpaceWindowIfFocused('in')) {
        state.mainWindow?.webContents.send('terminal:zoom', 'in')
      }
    },
    onZoomOut: () => {
      if (!zoomDashboardPopoutIfFocused('out') && !zoomWorkspaceSpaceWindowIfFocused('out')) {
        state.mainWindow?.webContents.send('terminal:zoom', 'out')
      }
    },
    onZoomReset: () => {
      if (!zoomDashboardPopoutIfFocused('reset') && !zoomWorkspaceSpaceWindowIfFocused('reset')) {
        state.mainWindow?.webContents.send('terminal:zoom', 'reset')
      }
    },
    onToggleLeftSidebar: () => state.mainWindow?.webContents.send('ui:toggleLeftSidebar'),
    onToggleRightSidebar: () => state.mainWindow?.webContents.send('ui:toggleRightSidebar'),
    onToggleAppearance: (key) => {
      if (key === 'statusBarVisible') {
        // Renderer owns this persisted UI-state toggle; forward it rather than write settings.
        state.mainWindow?.webContents.send('ui:toggleStatusBar')
        return
      }
      const current = store.getSettings()
      // Missing default-on values must toggle from visible to hidden.
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
