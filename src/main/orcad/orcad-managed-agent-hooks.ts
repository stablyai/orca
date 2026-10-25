import { getAppEnvironment } from '../../shared/app-environment'
import { startCodexHooks } from '../codex/codex-hook-reconcile'
import { adoptLoginShellAgentHomes } from '../agent-hooks/agent-home-login-shell'
import { hydrateAgentCliShellPath } from '../agent-hooks/local-agent-cli-presence'
import {
  isAgentStatusHooksEnabled,
  isAgentStatusHooksEnabledForAgent
} from '../agent-hooks/managed-agent-hook-controls'
import { reconcileStartupManagedAgentHooks } from '../agent-hooks/managed-agent-hook-startup'
import { refreshInstalledOpenCodeStatusPlugins } from '../opencode/opencode-status-plugin-startup-refresh'
import type { ProfilePreferences } from '../persistence/loading-store/profile-preferences'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

/**
 * Keeps this host's hook server and its agents' hook configs true to its settings. The startup
 * reconcile is the desktop's: without it a freshly managed SSH host only got hooks when its hook
 * settings changed, so its agents never reported status.
 */
export function startOrcadManagedAgentHooks(
  store: Pick<ProfilePreferences, 'getSettings' | 'onSettingsChanged'>,
  setStatusHooksEnabled: (enabled: boolean) => void,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
): void {
  let stopping = false
  const removeSettingsListener = store.onSettingsChanged((updates, settings) => {
    if ('agentStatusHooksEnabled' in updates) {
      setStatusHooksEnabled(isAgentStatusHooksEnabled(settings))
    }
  })
  registerCleanup(() => {
    stopping = true
    removeSettingsListener()
  })
  const getSettings = () => store.getSettings()
  const shouldHydrateShellPath = getAppEnvironment().isPackaged()
  startCodexHooks({
    pathReady: shouldHydrateShellPath ? hydrateAgentCliShellPath() : Promise.resolve(),
    isEnabled: () => isAgentStatusHooksEnabledForAgent(getSettings(), 'codex'),
    // Why null: orcad launches Codex on ~/.codex; Orca-managed account homes are a desktop flow.
    resolveLaunchHome: () => null
  })
  void adoptLoginShellAgentHomes().then(() =>
    reconcileStartupManagedAgentHooks({
      getSettings,
      isQuitting: () => stopping,
      shouldHydrateShellPath
    })
  )
  try {
    refreshInstalledOpenCodeStatusPlugins(getSettings())
  } catch (error) {
    console.warn('[orcad] could not refresh OpenCode status plugins:', error)
  }
}
