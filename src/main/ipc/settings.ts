import { BrowserWindow, ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { PersistedState } from '../../shared/persisted-state-types'
import { listSystemFontFamilies } from '../window/desktop-integration/system-fonts'
import { registerSettingsImportHandlers } from './settings-import-handlers'
import type { AgentAwakeService } from '../power/agent-awake-service'
import { applyPRBotAuthorOverride } from '../../shared/pr-bot-author-overrides'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { readSettingsWithRuntimeEnvironmentPreference } from './runtime-environments/runtime-environment-preference'
import { getRuntimeEnvironmentRegistryRoot } from './runtime-environments/runtime-environment-registry-root'
import { applySettingsWrite } from './settings-write'

const registryRoot = getRuntimeEnvironmentRegistryRoot

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

  ipcMain.handle('settings:get', () =>
    readSettingsWithRuntimeEnvironmentPreference(store, registryRoot())
  )

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

  // PTYs can bind before hydration; transport authority selection needs persisted settings synchronously.
  ipcMain.on('settings:get-sync', (event) => {
    event.returnValue = readSettingsWithRuntimeEnvironmentPreference(store, registryRoot())
  })

  ipcMain.handle('settings:set', (event, args: Partial<GlobalSettings>) =>
    applySettingsWrite(store, args, { originWebContentsId: event.sender.id, agentAwakeService })
  )

  ipcMain.handle(
    'settings:set-active-runtime-environment-preference',
    (event, args: { environmentId?: unknown }): GlobalSettings => {
      const requestedEnvironmentId = args?.environmentId
      if (requestedEnvironmentId !== null && typeof requestedEnvironmentId !== 'string') {
        throw new Error('Invalid default host for new projects')
      }
      const requestedId = requestedEnvironmentId?.trim() || null
      const environmentId =
        requestedId === null ? null : resolveEnvironment(registryRoot(), requestedId).id
      return store.updateSettings(
        { activeRuntimeEnvironmentId: environmentId },
        { notifyListeners: true, originWebContentsId: event.sender.id }
      )
    }
  )

  ipcMain.handle('settings:listFonts', () => listSystemFontFamilies())

  registerSettingsImportHandlers(store)

  ipcMain.handle('cache:getGitHub', () => {
    return store.getGitHubCache()
  })

  ipcMain.handle('cache:setGitHub', (_event, args: { cache: PersistedState['githubCache'] }) => {
    store.setGitHubCache(args.cache)
  })
}
