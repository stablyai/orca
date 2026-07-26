import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import type { Store } from '../persistence'
import type { GlobalSettings, PersistedState } from '../../shared/types'
import { listSystemFontFamilies } from '../system-fonts'
import { previewGhosttyImport } from '../ghostty/index'
import { previewWarpThemeImport } from '../warp-themes'
import { setMainUiLanguage } from '../i18n/main-i18n'
import { rebuildAppMenu } from '../menu/register-app-menu'
import { track } from '../telemetry/client'
import { SETTINGS_CHANGED_WHITELIST, type SettingsChangedKey } from '../../shared/telemetry-events'
import type { AgentAwakeService } from '../agent-awake-service'
import { sanitizeFloatingWorkspaceDirectorySetting } from './floating-workspace-directory'
import { applyAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import { applyElectronProxySettings } from '../network/proxy-settings'
import { normalizeProxyBypassRules, normalizeProxyUrl } from '../../shared/network-proxy'
import { normalizeAppIconId } from '../../shared/app-icon'
import { normalizeUiLanguage } from '../../shared/ui-language'
import { applyAppIcon } from '../app-icon'
import { normalizeTerminalCustomThemes } from '../../shared/terminal-custom-themes'
import { normalizeDesktopTerminalScrollbackRows } from '../../shared/terminal-scrollback-policy'
import { normalizeTerminalLineHeight } from '../../shared/terminal-line-height-settings'
import { prepareLocalWorktreeRootsForRepos } from '../worktree-root-preparation'
import { scheduleCurrentWorktreeBaseDirectoryWatcherSync } from './worktree-base-directory-watcher'
import { applyPRBotAuthorOverride } from '../../shared/pr-bot-author-overrides'
import { resolveEnvironment } from '../../shared/runtime-environment-store'

// Why: the whitelist is the source-of-truth for which keys we emit on. Casting
// to a Set once at module load lets the IPC handler's per-key membership
// check stay O(1) without re-coercing the readonly tuple on every call.
const SETTINGS_CHANGED_WHITELIST_SET = new Set<string>(SETTINGS_CHANGED_WHITELIST)

type LegacyTerminalScrollbackSettingsUpdate = Partial<GlobalSettings> & {
  terminalScrollbackBytes?: unknown
}

function sanitizeRendererSettingsUpdate(args: Partial<GlobalSettings>): Partial<GlobalSettings> {
  const { terminalScrollbackBytes: _legacyScrollbackBytes, ...sanitizedArgs } =
    args as LegacyTerminalScrollbackSettingsUpdate
  void _legacyScrollbackBytes
  return sanitizedArgs
}

// Why: fields that appear in the View > Appearance submenu need the menu
// rebuilt after any update so the checkbox `checked` state stays in sync
// with the persisted value. Electron doesn't reactively re-render menu
// items when the backing state changes.
const APPEARANCE_MENU_KEYS: readonly (keyof GlobalSettings)[] = [
  'showTasksButton',
  'showAutomationsButton',
  'showMobileButton',
  'showTitlebarAppName'
]

export function registerSettingsHandlers(
  store: Store,
  agentAwakeService?: AgentAwakeService
): void {
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
    return store.getSettings()
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
    event.returnValue = store.getSettings()
  })

  ipcMain.handle('settings:set', async (event, args: Partial<GlobalSettings>) => {
    const sanitizedArgs = sanitizeRendererSettingsUpdate(args)
    // Why: connection/navigation code receives the generic settings writer; the
    // durable server preference has a dedicated Advanced-control boundary.
    delete sanitizedArgs.activeRuntimeEnvironmentId
    // Why: Floating Workspace grants are trusted only when written by the
    // main-process directory picker, never by renderer-provided settings IPC.
    delete sanitizedArgs.floatingTerminalTrustedCwds
    if (typeof args.floatingTerminalCwd === 'string') {
      sanitizedArgs.floatingTerminalCwd = await sanitizeFloatingWorkspaceDirectorySetting(
        store,
        args.floatingTerminalCwd
      )
    }
    if ('httpProxyUrl' in args) {
      const proxyUrl = normalizeProxyUrl(args.httpProxyUrl)
      sanitizedArgs.httpProxyUrl = proxyUrl.ok ? proxyUrl.value : ''
    }
    if ('httpProxyBypassRules' in args) {
      sanitizedArgs.httpProxyBypassRules = normalizeProxyBypassRules(args.httpProxyBypassRules)
    }
    if ('appIcon' in args) {
      sanitizedArgs.appIcon = normalizeAppIconId(args.appIcon)
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
    if (args.theme) {
      nativeTheme.themeSource = args.theme
    }
    // Why: capture the pre-update value so we only emit when the value
    // actually changes. The settings UI sometimes re-saves the same value
    // (e.g. blur after a no-op edit), and a `settings_changed` event for a
    // no-op flip would inflate the experimental-feature-adoption signal.
    const before = store.getSettings()
    const result = store.updateSettings(sanitizedArgs, {
      notifyListeners: true,
      originWebContentsId: event.sender.id
    })
    if ('keepComputerAwakeWhileAgentsRun' in sanitizedArgs) {
      agentAwakeService?.setEnabled(result.keepComputerAwakeWhileAgentsRun)
    }
    if (
      'agentStatusHooksEnabled' in sanitizedArgs &&
      before.agentStatusHooksEnabled !== result.agentStatusHooksEnabled
    ) {
      try {
        applyAgentStatusHooksEnabled(result.agentStatusHooksEnabled)
      } catch (error) {
        console.warn('[settings] failed to apply agentStatusHooksEnabled:', error)
      }
    }
    if ('uiLanguage' in sanitizedArgs && before.uiLanguage !== result.uiLanguage) {
      await setMainUiLanguage(result.uiLanguage)
      rebuildAppMenu()
    }
    if (
      ('workspaceDir' in sanitizedArgs && before.workspaceDir !== result.workspaceDir) ||
      ('nestWorkspaces' in sanitizedArgs && before.nestWorkspaces !== result.nestWorkspaces)
    ) {
      void prepareLocalWorktreeRootsForRepos(store)
      scheduleCurrentWorktreeBaseDirectoryWatcherSync()
    }
    if (APPEARANCE_MENU_KEYS.some((key) => key in sanitizedArgs)) {
      rebuildAppMenu()
    }
    if ('httpProxyUrl' in sanitizedArgs || 'httpProxyBypassRules' in sanitizedArgs) {
      try {
        await applyElectronProxySettings(result)
      } catch {
        console.warn('[settings] failed to apply network proxy settings')
      }
    }
    if ('appIcon' in sanitizedArgs && before.appIcon !== result.appIcon) {
      applyAppIcon(result.appIcon)
    }

    // Why: telemetry-plan.md§Settings — fire `settings_changed` only for
    // whitelisted keys, with `value_kind` distinguishing booleans from
    // string-enum settings. We deliberately do NOT send the raw value for
    // non-enum settings; the whitelist is currently scoped to experimental
    // toggles, all of which are booleans, so `value_kind === 'bool'` is
    // the path the v1 enum has a slot for. If a non-bool whitelisted
    // setting is ever added, extend the discriminator here at the same
    // time the schema's `value_kind` enum gains the new value.
    for (const key of Object.keys(sanitizedArgs)) {
      if (!SETTINGS_CHANGED_WHITELIST_SET.has(key)) {
        continue
      }
      const beforeValue = (before as Record<string, unknown>)[key]
      const afterValue = (result as Record<string, unknown>)[key]
      if (beforeValue === afterValue) {
        continue
      }
      if (typeof afterValue !== 'boolean') {
        // No non-bool whitelist entries today; skip rather than guess.
        continue
      }
      track('settings_changed', {
        setting_key: key as SettingsChangedKey,
        value_kind: 'bool'
      })
    }

    return result
  })

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
