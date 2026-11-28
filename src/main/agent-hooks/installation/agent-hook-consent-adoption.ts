import type {
  AgentHookInstallStatus,
  AgentHookTarget
} from '../../../shared/agent-hook-listener/configuration/agent-hook-types'
import {
  readAgentHookConsent,
  withAgentHookConsent,
  type AgentHookConsent
} from '../../../shared/agent-hook-listener/configuration/agent-hook-consent'

type ConsentSettings = { agentHookConsent?: AgentHookConsent } | null

/** Undecided agents whose Orca hooks are already in their config: installed before consent existed, or by another profile. */
export function findAdoptableAgentHooks(
  settings: ConsentSettings,
  statuses: readonly AgentHookInstallStatus[]
): AgentHookTarget[] {
  return statuses
    .filter((status) => status.managedHooksPresent && !readAgentHookConsent(settings, status.agent))
    .map((status) => status.agent)
}

export type AgentHookConsentStore = {
  getSettings: () => ConsentSettings
  writeConsent: (consent: AgentHookConsent) => void
}

/** Records present hooks as granted so they keep working and are never asked about; writes nothing else. */
export function adoptPresentAgentHooks(
  store: AgentHookConsentStore,
  readStatuses: () => readonly AgentHookInstallStatus[]
): AgentHookTarget[] {
  const adopted = findAdoptableAgentHooks(store.getSettings(), readStatuses())
  if (adopted.length > 0) {
    store.writeConsent(
      withAgentHookConsent(store.getSettings()?.agentHookConsent, adopted, 'granted')
    )
  }
  return adopted
}
