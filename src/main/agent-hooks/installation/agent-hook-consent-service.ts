import { homedir } from 'node:os'
import type {
  AgentHookInstallStatus,
  AgentHookTarget
} from '../../../shared/agent-hook-listener/configuration/agent-hook-types'
import {
  isAgentHookTarget,
  readAgentHookConsent,
  withAgentHookConsent,
  withoutAgentHookConsent,
  type AgentHookConsent,
  type AgentHookConsentDecision
} from '../../../shared/agent-hook-listener/configuration/agent-hook-consent'
import { MANAGED_AGENT_HOOK_TARGETS } from '../../../shared/agent-hook-listener/configuration/managed-agent-hook-targets'
import {
  isAgentStatusHooksEnabled,
  isAgentStatusHooksEnabledForAgent
} from '../../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import { isTuiAgentEnabled } from '../../../shared/agent-launch/catalog/tui-agent-selection'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import type { AgentHookConsentOffer } from '../../../shared/agent-hook-listener/configuration/agent-hook-consent-offer'
import { adoptPresentAgentHooks } from './agent-hook-consent-adoption'
import { recordManagedHookInstallFailure } from './install-telemetry'
import {
  getManagedAgentHookStatuses,
  installManagedAgentHooks,
  removeManagedAgentHooks
} from './managed-agent-hook-controls'

export type ConsentServiceStore = {
  getSettings: () => GlobalSettings
  updateSettings: (
    updates: Partial<GlobalSettings>,
    options?: { notifyListeners?: boolean }
  ) => unknown
}

const NO_OFFER: AgentHookConsentOffer = { ask: false, agents: [], configPath: '' }

function shortHomePath(path: string): string {
  const home = homedir()
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

export function createAgentHookConsentService(
  store: ConsentServiceStore,
  options: { shouldHydrateShellPath: boolean }
) {
  const writeConsent = (agentHookConsent: AgentHookConsent): void => {
    store.updateSettings({ agentHookConsent }, { notifyListeners: true })
  }

  /** Whether to ask about `agent`, plus the other undecided agents; the renderer keeps those it detected. */
  function resolveOffer(agent: string): AgentHookConsentOffer {
    const settings = store.getSettings()
    if (!isAgentHookTarget(agent) || !isAgentStatusHooksEnabled(settings)) {
      return NO_OFFER
    }
    // Why re-check here: a restored pane can appear before startup's adoption pass has run.
    adoptPresentAgentHooks(
      { getSettings: () => store.getSettings(), writeConsent },
      getManagedAgentHookStatuses
    )
    const current = store.getSettings()
    if (readAgentHookConsent(current, agent) !== null) {
      return NO_OFFER
    }
    const others = MANAGED_AGENT_HOOK_TARGETS.filter(
      (target) =>
        target.agent !== agent &&
        readAgentHookConsent(current, target.agent) === null &&
        isTuiAgentEnabled(target.tuiAgent, current.disabledTuiAgents)
    ).map((target) => target.agent)
    const configPath =
      getManagedAgentHookStatuses().find((status) => status.agent === agent)?.configPath ?? ''
    return { ask: true, agents: [agent, ...others], configPath: shortHomePath(configPath) }
  }

  /** Granting installs right away and keeps consent only where the install worked; declining removes Orca's hooks. */
  async function applyDecision(
    agents: readonly AgentHookTarget[],
    decision: AgentHookConsentDecision
  ): Promise<AgentHookInstallStatus[]> {
    writeConsent(withAgentHookConsent(store.getSettings().agentHookConsent, agents, decision))
    if (decision === 'declined') {
      // Always attempt removal so a retry after a failed removal still cleans up.
      return await removeManagedAgentHooks({ agents: [...agents] })
    }
    const statuses = await installManagedAgentHooks(store.getSettings(), {
      agents,
      userInitiated: true,
      shouldHydrateShellPath: options.shouldHydrateShellPath,
      onInstallError: recordManagedHookInstallFailure,
      // Live check: the global switch or this consent can change while the install runs.
      shouldContinue: (agent) => isAgentStatusHooksEnabledForAgent(store.getSettings(), agent)
    })
    const consent = store.getSettings().agentHookConsent
    const failed = statuses
      .filter((status) => status.state === 'error' && consent?.[status.agent] === 'granted')
      .map((status) => status.agent)
    if (failed.length > 0) {
      writeConsent(withoutAgentHookConsent(consent, failed))
    }
    return statuses
  }

  // Why serialize: a decline must never be overtaken by an install still in flight.
  let queue: Promise<unknown> = Promise.resolve()
  function decide(
    agents: readonly AgentHookTarget[],
    decision: AgentHookConsentDecision
  ): Promise<AgentHookInstallStatus[]> {
    const next = queue.then(
      () => applyDecision(agents, decision),
      () => applyDecision(agents, decision)
    )
    queue = next.catch(() => undefined)
    return next
  }

  return { resolveOffer, decide, statuses: getManagedAgentHookStatuses }
}
