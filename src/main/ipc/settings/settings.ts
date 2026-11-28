import { BrowserWindow, ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import { registerLazySettingsImportAndAppIconHandlers } from './lazy-settings-import-and-app-icon-ipc'
import type { AgentAwakeService } from '../../power/agent-awake-service'
import { applyAutomaticUpdatesSetting } from '../../updater/updater-service-slot'
import { readSettingsWithRuntimeEnvironmentPreference } from '../runtime-environments/catalog/runtime-environment-preference'
import { getRuntimeEnvironmentRegistryRoot } from '../runtime-environments/catalog/runtime-environment-registry-root'

const registryRoot = getRuntimeEnvironmentRegistryRoot

export function registerSettingsHandlers(
  store: Store,
  agentAwakeService?: AgentAwakeService
): void {
  registerLazySettingsImportAndAppIconHandlers(store)
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
    applyAutomaticUpdatesSetting(updates.automaticUpdates)
    for (const window of BrowserWindow.getAllWindows()) {
      const isOrigin =
        originWebContentsId !== undefined && window.webContents.id === originWebContentsId
      if (!window.isDestroyed() && !isOrigin) {
        window.webContents.send('settings:changed', updates)
      }
    }
  })

  ipcMain.handle(
    'settings:get',
    async () => await readSettingsWithRuntimeEnvironmentPreference(store, registryRoot())
  )

  ipcMain.handle(
    'settings:update-pr-bot-author-override',
    async (event, args: { author: string; isBot: boolean }) => {
      const { applyPRBotAuthorOverride } =
        await import('../../../shared/source-control/review-comments/pr-bot-author-overrides')
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
  ipcMain.on('settings:get-sync', async (event) => {
    event.returnValue = await readSettingsWithRuntimeEnvironmentPreference(store, registryRoot())
  })

  ipcMain.handle('settings:set', async (event, args: Partial<GlobalSettings>) => {
    const { handleSettingsSet } = await import('./settings-set-handler')
    const { sanitizedArgs, before, result } = await handleSettingsSet(
      store,
      agentAwakeService,
      event,
      args
    )
    if ('appIcon' in sanitizedArgs && before.appIcon !== result.appIcon) {
      const { applyAppIcon } = await import('../../window/desktop-integration/app-icon')
      applyAppIcon(result.appIcon)
    }
    if ('aiVaultSearch' in sanitizedArgs) {
      const { applySessionSearchSettingsChange } =
        await import('../../ai-vault-search/session-search-enablement')
      applySessionSearchSettingsChange(before, result)
    }
    return store.getSettings()
  })

  ipcMain.handle(
    'settings:set-active-runtime-environment-preference',
    async (event, args: { environmentId?: unknown }): Promise<GlobalSettings> => {
      const requestedEnvironmentId = args?.environmentId
      if (requestedEnvironmentId !== null && typeof requestedEnvironmentId !== 'string') {
        throw new Error('Invalid default host for new projects')
      }
      const requestedId = requestedEnvironmentId?.trim() || null
      let environmentId: string | null = null
      if (requestedId !== null) {
        const { resolveEnvironment } =
          await import('../../../shared/remote-runtime/host-store/runtime-environment-store')
        environmentId = (await resolveEnvironment(registryRoot(), requestedId)).id
      }
      return store.updateSettings(
        { activeRuntimeEnvironmentId: environmentId },
        { notifyListeners: true, originWebContentsId: event.sender.id }
      )
    }
  )

  ipcMain.handle('settings:listFonts', async () => {
    const { listSystemFontFamilies } = await import('../../window/desktop-integration/system-fonts')
    return listSystemFontFamilies()
  })

  ipcMain.handle('cache:getGitHub', () => {
    return store.getGitHubCache()
  })

  ipcMain.handle('cache:setGitHub', (_event, args: { cache: PersistedState['githubCache'] }) => {
    store.setGitHubCache(args.cache)
  })
}
