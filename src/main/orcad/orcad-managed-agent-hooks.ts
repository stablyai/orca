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

/** Reconcile hooks at startup as well as setting changes so newly managed hosts report status immediately. */
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
