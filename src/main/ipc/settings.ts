import { app, BrowserWindow, ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { PersistedState } from '../../shared/persisted-state-types'
import { listSystemFontFamilies } from '../system-fonts'
import { previewGhosttyImport } from '../ghostty/index'
import { previewWarpThemeImport } from '../warp-themes'
import type { AgentAwakeService } from '../agent-awake-service'
import { applyPRBotAuthorOverride } from '../../shared/pr-bot-author-overrides'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { readSettingsWithRuntimeEnvironmentPreference } from './runtime-environment-preference'
import { applySettingsWrite } from './settings-write'

export function registerSettingsHandlers(
  store: Store,
  agentAwakeService?: AgentAwakeService
): void {
  ipcMain.handle(
    'agentAwake:getStatus',
    () => agentAwakeService?.getStatus() ?? { mode: 'off', active: false }
  )
  agentAwakeService?.subscribe?.((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('agentAwake:changed', status)
      }
    }
  })

  store.onSettingsChanged((updates, _settings, originWebContentsId) => {
    for (const window of BrowserWindow.getAllWindows()) {
      const isOrigin =
        originWebContentsId !== undefined && window.webContents.id === originWebContentsId
      if (!window.isDestroyed() && !isOrigin) {
        window.webContents.send('settings:changed', updates)
      }
    }
  })

  ipcMain.handle('settings:get', () => {
    return readSettingsWithRuntimeEnvironmentPreference(store, app.getPath('userData'))
  })

  ipcMain.handle(
    'settings:update-pr-bot-author-override',
    (event, args: { author: string; isBot: boolean }) => {
      const current = store.getSettings().prBotAuthorOverrides
      const next = applyPRBotAuthorOverride(current, args.author, args.isBot)
      store.updateSettings(
        { prBotAuthorOverrides: next },
        { notifyListeners: true, originWebContentsId: event.sender.id }
      )
      return store.getSettings()
    }
  )

  // Why: terminal panes can bind PTYs before async settings hydration
  // completes. The side-effect authority kill switch is consulted once at
  // transport creation, so the renderer needs the persisted value
  // synchronously or pre-hydration bindings would always pick main authority
  // (terminal-side-effect-authority.md, migration switch).
  ipcMain.on('settings:get-sync', (event) => {
    event.returnValue = readSettingsWithRuntimeEnvironmentPreference(store, app.getPath('userData'))
  })

  ipcMain.handle('settings:set', (event, args: Partial<GlobalSettings>) =>
    applySettingsWrite(store, args, { originWebContentsId: event.sender.id, agentAwakeService })
  )

  ipcMain.handle(
    'settings:set-active-runtime-environment-preference',
    (event, args: { environmentId?: unknown }): GlobalSettings => {
      const requestedEnvironmentId = args?.environmentId
      if (requestedEnvironmentId !== null && typeof requestedEnvironmentId !== 'string') {
        throw new Error('Invalid Active Server preference')
      }
      const requestedId = requestedEnvironmentId?.trim() || null
      const environmentId =
        requestedId === null ? null : resolveEnvironment(app.getPath('userData'), requestedId).id
      return store.updateSettings(
        { activeRuntimeEnvironmentId: environmentId },
        { notifyListeners: true, originWebContentsId: event.sender.id }
      )
    }
  )

  ipcMain.handle('settings:listFonts', () => {
    return listSystemFontFamilies()
  })

  ipcMain.handle('settings:previewGhosttyImport', () => {
    return previewGhosttyImport(store)
  })

  ipcMain.handle('settings:previewWarpThemeImport', (event, args?: unknown) => {
    const source = args === undefined ? { kind: 'auto' } : args
    return previewWarpThemeImport(store, source, event.sender)
  })

  ipcMain.handle('cache:getGitHub', () => {
    return store.getGitHubCache()
  })

  ipcMain.handle('cache:setGitHub', (_event, args: { cache: PersistedState['githubCache'] }) => {
    store.setGitHubCache(args.cache)
  })
}
