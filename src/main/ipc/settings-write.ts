import { app, nativeTheme } from 'electron'
import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { setMainUiLanguage } from '../i18n/main-i18n'
import { rebuildAppMenu } from '../menu/register-app-menu'
import { rebuildSystemTrayMenu } from '../tray/system-tray'
import { track } from '../telemetry/client'
import { SETTINGS_CHANGED_WHITELIST, type SettingsChangedKey } from '../../shared/telemetry-events'
import type { AgentAwakeService } from '../agent-awake-service'
import { sanitizeFloatingWorkspaceDirectorySetting } from './floating-workspace-directory'
import { applyAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import { recordManagedHookInstallFailure } from '../agent-hooks/install-telemetry'
import { applyElectronProxySettings } from '../network/proxy-settings'
import { applyBrowserSessionProxies } from '../browser/browser-session-proxy'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { sanitizeNetworkSettings } from './network-settings-sanitization'
import { normalizeAppIconId } from '../../shared/app-icon'
import { normalizeUiLanguage } from '../../shared/ui-language'
import { applyAppIcon } from '../app-icon'
import { normalizeTerminalCustomThemes } from '../../shared/terminal-custom-themes'
import { normalizeDesktopTerminalScrollbackRows } from '../../shared/terminal-scrollback-policy'
import { normalizeTerminalLineHeight } from '../../shared/terminal-line-height-settings'
import { prepareLocalWorktreeRootsForRepos } from '../worktree-root-preparation'
import { scheduleCurrentWorktreeBaseDirectoryWatcherSync } from './worktree-base-directory-watcher'
import { haveSameDisabledTuiAgents } from '../../shared/tui-agent-selection'
import {
  normalizeMobilePairingCustomAddress,
  normalizeMobilePairingCustomAddresses
} from '../../shared/mobile-pairing-custom-address'
import {
  computerAwakeSettingsForMode,
  normalizeComputerAwakeMode
} from '../../shared/computer-awake-mode'
import { resolveAiVaultSearchSettings } from '../../shared/ai-vault-search-settings'
import { applySessionSearchSettingsChange } from '../ai-vault-search/session-search-enablement'

const SETTINGS_CHANGED_WHITELIST_SET = new Set<string>(SETTINGS_CHANGED_WHITELIST)

type LegacyTerminalScrollbackSettingsUpdate = Partial<GlobalSettings> & {
  terminalScrollbackBytes?: unknown
}

function sanitizeRendererSettingsUpdate(args: Partial<GlobalSettings>): Partial<GlobalSettings> {
  const { terminalScrollbackBytes: _legacyScrollbackBytes, ...sanitizedArgs } =
    args as LegacyTerminalScrollbackSettingsUpdate
  void _legacyScrollbackBytes
  // Plugin consent and enablement require main's reviewed-fingerprint handlers.
  delete sanitizedArgs.pluginConsents
  delete sanitizedArgs.disabledPlugins
  return sanitizedArgs
}

// Electron menus do not react to settings; rebuild appearance checkboxes after writes.
const APPEARANCE_MENU_KEYS: readonly (keyof GlobalSettings)[] = [
  'showTasksButton',
  'showAutomationsButton',
  'showMobileButton',
  'showTitlebarAppName'
]

export type SettingsWriteContext = {
  originWebContentsId?: number
  agentAwakeService?: AgentAwakeService
}

/** The renderer settings write path: sanitize, persist, then run the side effects a changed key needs. */
export async function applySettingsWrite(
  store: Store,
  args: Partial<GlobalSettings>,
  context: SettingsWriteContext
): Promise<GlobalSettings> {
  const { agentAwakeService } = context
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
  // No-op UI saves must not inflate settings_changed adoption telemetry.
  const before = store.getSettings()
  const updateOptions = {
    notifyListeners: true,
    originWebContentsId: context.originWebContentsId
  }
  const result =
    'alwaysForceDeleteWorktrees' in sanitizedArgs ||
    'alwaysForceDeletePreservedBranches' in sanitizedArgs
      ? await store.updateSettingsAndFlush(sanitizedArgs, updateOptions)
      : store.updateSettings(sanitizedArgs, updateOptions)
  if (
    'experimentalAgentDashboardPopout' in sanitizedArgs &&
    before.experimentalAgentDashboardPopout !== result.experimentalAgentDashboardPopout
  ) {
    track('agent_dashboard_enabled', {
      enabled: result.experimentalAgentDashboardPopout === true
    })
  }
  const proxySettingsChanged =
    ('httpProxyUrl' in sanitizedArgs && before.httpProxyUrl !== result.httpProxyUrl) ||
    ('httpProxyBypassRules' in sanitizedArgs &&
      before.httpProxyBypassRules !== result.httpProxyBypassRules)
  if (proxySettingsChanged) {
    // Start both authorities before yielding so requests cannot enter between their barriers.
    const defaultSessionApply = applyElectronProxySettings(result)
    const browserSessionsApply = applyBrowserSessionProxies(
      browserSessionRegistry.listProfiles(),
      result
    )
    const [defaultSessionResult, browserSessionsResult] = await Promise.allSettled([
      defaultSessionApply,
      browserSessionsApply
    ])
    if (defaultSessionResult.status === 'rejected') {
      console.warn('[settings] failed to apply network proxy settings')
    }
    if (browserSessionsResult.status === 'rejected') {
      console.warn('[settings] failed to apply network proxy settings to browser sessions')
    }
  }
  if ('computerAwakeMode' in sanitizedArgs || 'keepComputerAwakeWhileAgentsRun' in sanitizedArgs) {
    agentAwakeService?.setMode(
      normalizeComputerAwakeMode(result.computerAwakeMode, result.keepComputerAwakeWhileAgentsRun)
    )
  }
  const hookSettingChanged =
    ('agentStatusHooksEnabled' in sanitizedArgs &&
      before.agentStatusHooksEnabled !== result.agentStatusHooksEnabled) ||
    ('disabledTuiAgents' in sanitizedArgs &&
      !haveSameDisabledTuiAgents(before.disabledTuiAgents, result.disabledTuiAgents))
  if (hookSettingChanged) {
    try {
      await applyAgentStatusHooksEnabled(result.agentStatusHooksEnabled, result, {
        userInitiated: true,
        shouldHydrateShellPath: app.isPackaged,
        onInstallError: recordManagedHookInstallFailure,
        shouldContinue: (agent) => isAgentStatusHooksEnabledForAgent(store.getSettings(), agent)
      })
    } catch (error) {
      console.warn('[settings] failed to reconcile managed agent hooks:', error)
    }
  }
  if ('uiLanguage' in sanitizedArgs && before.uiLanguage !== result.uiLanguage) {
    await setMainUiLanguage(result.uiLanguage)
    rebuildAppMenu()
    rebuildSystemTrayMenu()
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
  if ('appIcon' in sanitizedArgs && before.appIcon !== result.appIcon) {
    applyAppIcon(result.appIcon)
  }
  if ('aiVaultSearch' in sanitizedArgs) {
    applySessionSearchSettingsChange(before, result)
  }

  // Emit only allowlisted keys without raw values; new value kinds require matching schema support.
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
      // Unsupported value kinds must not be guessed.
      continue
    }
    track('settings_changed', {
      setting_key: key as SettingsChangedKey,
      value_kind: 'bool'
    })
  }

  return store.getSettings()
}
