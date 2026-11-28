import {
  isAgentStatusHooksEnabled,
  isAgentStatusHooksEnabledForAgent
} from '../../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import { recordManagedHookInstallFailure } from './install-telemetry'
import type { installManagedAgentHooks } from './managed-agent-hook-controls'

type StartupHookSettings = NonNullable<Parameters<typeof installManagedAgentHooks>[0]>

export function reconcileStartupManagedAgentHooks(host: {
  getSettings: () => StartupHookSettings
  isQuitting: () => boolean
  shouldHydrateShellPath: boolean
}): void {
  if (!isAgentStatusHooksEnabled(host.getSettings())) {
    return
  }
  void import('./managed-agent-hook-controls')
    .then(({ installManagedAgentHooks: installHooks }) => {
      if (host.isQuitting()) {
        return
      }
      return installHooks(host.getSettings(), {
        shouldHydrateShellPath: host.shouldHydrateShellPath,
        onInstallError: recordManagedHookInstallFailure,
        shouldContinue: (agent) =>
          !host.isQuitting() && isAgentStatusHooksEnabledForAgent(host.getSettings(), agent)
      })
    })
    .catch((error: unknown) =>
      console.warn('[agent-hooks] failed to reconcile managed hooks on startup:', error)
    )
}
