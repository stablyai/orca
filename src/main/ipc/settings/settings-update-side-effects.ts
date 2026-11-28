import { app } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { setMainUiLanguage } from '../../i18n/main-i18n'
import { rebuildAppMenu } from '../../menu/register-app-menu'
import { rebuildSystemTrayMenu } from '../../tray/system-tray'
import { track } from '../../telemetry/client'
import {
  SETTINGS_CHANGED_WHITELIST,
  type SettingsChangedKey
} from '../../../shared/telemetry/schemas/telemetry-property-schemas'
import type { AgentAwakeService } from '../../power/agent-awake-service'
import { isAgentStatusHooksEnabledForAgent } from '../../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import { applyElectronProxySettings } from '../../network/proxy-settings'
import { applyBrowserSessionProxies } from '../../browser/sessions/proxy/browser-session-proxy'
import { applyProxyToElectronUpdaterSession } from '../../updater/lifecycle/electron-updater-proxy-session'
import { browserSessionRegistry } from '../../browser/sessions/profiles/browser-session-registry'
import { prepareLocalWorktreeRootsForRepos } from '../../workspaces/creation/worktree-root-preparation'
import { scheduleCurrentWorktreeBaseDirectoryWatcherSync } from '../worktrees/creation/worktree-base-directory-watcher'
import { haveSameDisabledTuiAgents } from '../../../shared/agent-launch/catalog/tui-agent-selection'
import { normalizeComputerAwakeMode } from '../../../shared/app-lifecycle/computer-awake-mode'

const SETTINGS_CHANGED_WHITELIST_SET = new Set<string>(SETTINGS_CHANGED_WHITELIST)

// Electron menus do not react to settings; rebuild appearance checkboxes after writes.
const APPEARANCE_MENU_KEYS: readonly (keyof GlobalSettings)[] = [
  'showTasksButton',
  'showAutomationsButton',
  'showMobileButton',
  'showTitlebarAppName'
]

export async function applySettingsUpdateSideEffects(args: {
  store: Store
  agentAwakeService?: AgentAwakeService
  sanitizedArgs: Partial<GlobalSettings>
  before: GlobalSettings
  result: GlobalSettings
}): Promise<void> {
  const { store, agentAwakeService, sanitizedArgs, before, result } = args

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
    // Start every authority before yielding so requests cannot enter between their barriers.
    const [defaultSessionResult, browserSessionsResult] = await Promise.allSettled([
      applyElectronProxySettings(result),
      applyBrowserSessionProxies(browserSessionRegistry.listProfiles(), result),
      applyProxyToElectronUpdaterSession(result)
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
  const { getClaudeAgentViewService } = await import('../../claude/agent-view/agent-view-service')
  await getClaudeAgentViewService().reconcile(result)
  const hookSettingChanged =
    ('agentStatusHooksEnabled' in sanitizedArgs &&
      before.agentStatusHooksEnabled !== result.agentStatusHooksEnabled) ||
    ('disabledTuiAgents' in sanitizedArgs &&
      !haveSameDisabledTuiAgents(before.disabledTuiAgents, result.disabledTuiAgents))
  if (hookSettingChanged) {
    try {
      const [{ applyAgentStatusHooksEnabled }, { recordManagedHookInstallFailure }] =
        await Promise.all([
          import('../../agent-hooks/installation/managed-agent-hook-controls'),
          import('../../agent-hooks/installation/install-telemetry')
        ])
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
}
