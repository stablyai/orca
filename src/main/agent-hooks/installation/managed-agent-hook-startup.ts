import {
  isAgentStatusHooksEnabled,
  isAgentStatusHooksEnabledForAgent
} from '../../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import type { AgentHookConsent } from '../../../shared/agent-hook-listener/configuration/agent-hook-consent'
import { recordManagedHookInstallFailure } from './install-telemetry'
import type { installManagedAgentHooks } from './managed-agent-hook-controls'

type StartupHookSettings = NonNullable<Parameters<typeof installManagedAgentHooks>[0]>

export function reconcileStartupManagedAgentHooks(host: {
  getSettings: () => StartupHookSettings
  writeConsent: (consent: AgentHookConsent) => void
  isQuitting: () => boolean
  shouldHydrateShellPath: boolean
}): void {
  if (!isAgentStatusHooksEnabled(host.getSettings())) {
    return
  }
  // Why lazy: the installers for every agent stay off the cold-boot module graph (#51052).
  void Promise.all([
    import('./managed-agent-hook-controls'),
    import('./agent-hook-consent-adoption')
  ])
    .then(async ([controls, adoption]) => {
      if (host.isQuitting()) {
        return
      }
      adoption.adoptPresentAgentHooks(host, controls.getManagedAgentHookStatuses)
      // Repairs only granted agents; undecided ones wait for the user's answer on the card.
      await controls.installManagedAgentHooks(host.getSettings(), {
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
