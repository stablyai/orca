import { sanitizeRendererSettingsUpdate } from './renderer-settings-update'
import { BrowserWindow, ipcMain, nativeTheme } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import { registerLazySettingsImportAndAppIconHandlers } from './lazy-settings-import-and-app-icon-ipc'
import type { AgentAwakeService } from '../../power/agent-awake-service'
import { sanitizeFloatingWorkspaceDirectorySetting } from '../worktrees/floating-workspace-directory'
import { applyAutomaticUpdatesSetting } from '../../updater/updater-service'
import { sanitizeNetworkSettings } from './network-settings-sanitization'
import { normalizeAppIconId } from '../../../shared/app-lifecycle/identity/app-icon'
import { normalizeUiLanguage } from '../../../shared/i18n/ui-language'
import { normalizeTerminalCustomThemes } from '../../../shared/terminal-themes/terminal-custom-themes'
import { normalizeDesktopTerminalScrollbackRows } from '../../../shared/terminal/replay/terminal-scrollback-policy'
import { normalizeTerminalLineHeight } from '../../../shared/terminal/appearance/terminal-line-height-settings'
import { applyPRBotAuthorOverride } from '../../../shared/source-control/review-comments/pr-bot-author-overrides'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { readSettingsWithRuntimeEnvironmentPreference } from '../runtime-environments/catalog/runtime-environment-preference'
import {
  normalizeMobilePairingCustomAddress,
  normalizeMobilePairingCustomAddresses
} from '../../../shared/remote-runtime/pairing/mobile-pairing-custom-address'
import {
  computerAwakeSettingsForMode,
  normalizeComputerAwakeMode
} from '../../../shared/app-lifecycle/computer-awake-mode'
import { resolveAiVaultSearchSettings } from '../../../shared/ai-vault/search/ai-vault-search-settings'
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
  ipcMain.on('settings:get-sync', async (event) => {
    event.returnValue = await readSettingsWithRuntimeEnvironmentPreference(store, registryRoot())
  })

  ipcMain.handle('settings:set', async (event, args: Partial<GlobalSettings>) => {
    const sanitizedArgs = sanitizeRendererSettingsUpdate(args)
    // Generic settings writers cannot change the server preference owned by Advanced controls.
    delete sanitizedArgs.activeRuntimeEnvironmentId
    // Only the main-process directory picker may grant trusted floating-workspace paths.
    delete sanitizedArgs.floatingTerminalTrustedCwds
    if ('computerAwakeMode' in sanitizedArgs) {
      Object.assign(
        sanitizedArgs,
        computerAwakeSettingsForMode(
          normalizeComputerAwakeMode(
            sanitizedArgs.computerAwakeMode,
            sanitizedArgs.keepComputerAwakeWhileAgentsRun
          )
        )
      )
    } else if ('keepComputerAwakeWhileAgentsRun' in sanitizedArgs) {
      Object.assign(
        sanitizedArgs,
        computerAwakeSettingsForMode(sanitizedArgs.keepComputerAwakeWhileAgentsRun ? 'auto' : 'off')
      )
    }
    if (typeof args.floatingTerminalCwd === 'string') {
      sanitizedArgs.floatingTerminalCwd = await sanitizeFloatingWorkspaceDirectorySetting(
        store,
        args.floatingTerminalCwd
      )
    }
    sanitizeNetworkSettings(args, sanitizedArgs)
    if ('appIcon' in args) {
      sanitizedArgs.appIcon = normalizeAppIconId(args.appIcon)
    }
    if ('aiVaultSearch' in args) {
      sanitizedArgs.aiVaultSearch = resolveAiVaultSearchSettings(args)
    }
    if ('terminalCustomThemes' in args) {
      sanitizedArgs.terminalCustomThemes = normalizeTerminalCustomThemes(args.terminalCustomThemes)
    }
    if ('terminalScrollbackRows' in args) {
      sanitizedArgs.terminalScrollbackRows = normalizeDesktopTerminalScrollbackRows(
        args.terminalScrollbackRows
      )
    }
    if ('terminalLineHeight' in args) {
      sanitizedArgs.terminalLineHeight = normalizeTerminalLineHeight(args.terminalLineHeight)
    }
    if ('uiLanguage' in args) {
      sanitizedArgs.uiLanguage = normalizeUiLanguage(args.uiLanguage)
    }
    if ('mobilePairingCustomAddress' in args) {
      sanitizedArgs.mobilePairingCustomAddress = normalizeMobilePairingCustomAddress(
        args.mobilePairingCustomAddress
      )
    }
    if ('mobilePairingCustomAddresses' in args) {
      sanitizedArgs.mobilePairingCustomAddresses = normalizeMobilePairingCustomAddresses(
        args.mobilePairingCustomAddresses
      )
    }
    if (args.theme) {
      nativeTheme.themeSource = args.theme
    }
    if (sanitizedArgs.browserPasswordsFillRequiresReauth === false) {
      const { confirmBrowserPasswordOwner } =
        await import('../../browser-passwords/browser-password-reauth')
      if (
        store.getSettings().browserPasswordsFillRequiresReauth !== true ||
        !(await confirmBrowserPasswordOwner('turn off saved password fill authentication', {
          always: true
        }))
      ) {
        delete sanitizedArgs.browserPasswordsFillRequiresReauth
      }
    }
    // No-op UI saves must not inflate settings_changed adoption telemetry.
    const before = store.getSettings()
    const updateOptions = {
      notifyListeners: true,
      originWebContentsId: event.sender.id
    }
    const result =
      'alwaysForceDeleteWorktrees' in sanitizedArgs ||
      'alwaysForceDeletePreservedBranches' in sanitizedArgs
        ? await store.updateSettingsAndFlush(sanitizedArgs, updateOptions)
        : store.updateSettings(sanitizedArgs, updateOptions)
    const { applySettingsUpdateSideEffects } = await import('./settings-update-side-effects')
    await applySettingsUpdateSideEffects({
      store,
      agentAwakeService,
      sanitizedArgs,
      before,
      result
    })
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
      const environmentId =
        requestedId === null ? null : (await resolveEnvironment(registryRoot(), requestedId)).id
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
