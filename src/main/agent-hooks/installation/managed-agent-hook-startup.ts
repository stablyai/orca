import { recordManagedHookInstallFailure } from './install-telemetry'
import {
  getManagedAgentHookStatuses,
  installManagedAgentHooks,
  resolveStartupManagedHookAction,
  shouldContinueManagedHookStartup
} from './managed-agent-hook-controls'
import { adoptPresentAgentHooks } from './agent-hook-consent-adoption'
import type { AgentHookConsent } from '../../../shared/agent-hook-listener/configuration/agent-hook-consent'

type StartupHookSettings = NonNullable<Parameters<typeof installManagedAgentHooks>[0]>

export function reconcileStartupManagedAgentHooks(host: {
  getSettings: () => StartupHookSettings
  writeConsent: (consent: AgentHookConsent) => void
  isQuitting: () => boolean
  shouldHydrateShellPath: boolean
}): void {
  if (resolveStartupManagedHookAction(host.getSettings()) !== 'install') {
    return
  }
  void (async () => {
    // Why yield: status reads touch every agent's config; keep them off the synchronous startup path.
    await Promise.resolve()
    adoptPresentAgentHooks(host, getManagedAgentHookStatuses)
    // Repairs only granted agents; undecided ones wait for the user's answer on the card.
    await installManagedAgentHooks(host.getSettings(), {
      shouldHydrateShellPath: host.shouldHydrateShellPath,
      onInstallError: recordManagedHookInstallFailure,
      shouldContinue: (agent) =>
        shouldContinueManagedHookStartup(host.isQuitting(), host.getSettings(), agent)
    })
  })().catch((error: unknown) =>
    console.warn('[agent-hooks] failed to reconcile managed hooks on startup:', error)
  )
}
