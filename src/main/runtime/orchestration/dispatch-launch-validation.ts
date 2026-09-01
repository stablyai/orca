import { randomUUID } from 'node:crypto'
import type { TuiAgent } from '../../../shared/types'
import {
  normalizeAgentCatalog,
  type NormalizedAgentCatalogInput
} from '../../../shared/custom-tui-agents'
import type { AgentLaunchFailure } from '../../../shared/agent-launch-contract'
import {
  classifyRequestedState,
  type RequestedState
} from '../../agent-launch/resolve-agent-selection'
import type { DispatchAgentIdentity, DispatchAgentLaunchValidation } from './coordinator'

// Why (§U9 W-T1, U6 ledger #1/#16): orchestration dispatch re-validates a
// dispatch identity against the LIVE catalog with NO safe-fallback — unlike an
// interactive stored launch, a disabled/deleted agent hard-fails the dispatch so
// the operator retries the task explicitly. The classifier's failure codes are
// reused verbatim; only the fallback branches are dropped.
function dispatchLaunchFailureForState(state: RequestedState): AgentLaunchFailure | null {
  switch (state.state) {
    case 'enabled-built-in':
    case 'enabled-custom':
      return null
    case 'base-disabled':
    case 'disabled-built-in':
      return { code: 'base_agent_disabled', baseAgent: state.base }
    case 'disabled-custom':
      return { code: 'custom_agent_disabled', requestedAgent: state.agent, baseAgent: state.base }
    case 'repair-required':
      return { code: 'agent_definition_needs_repair', requestedAgent: state.agent }
    case 'missing-with-tombstone':
    case 'missing-no-tombstone':
      return { code: 'unknown_agent', requestedAgent: state.agent }
  }
}

/** Resolve-only re-validation of a dispatch's agent identity: classifies whether
 *  the requested agent still resolves to a launchable agent WITHOUT creating a
 *  terminal or routing through the launch boundary. `deps` inject id/clock so the
 *  taxonomy is unit-testable; the runtime supplies randomUUID + Date.now. */
export function validateDispatchIdentityAgainstCatalog(
  identity: DispatchAgentIdentity,
  settings: NormalizedAgentCatalogInput | undefined,
  deps: { mintFailureId: () => string; now: () => number } = {
    mintFailureId: () => randomUUID(),
    now: () => Date.now()
  }
): DispatchAgentLaunchValidation {
  const { catalog } = normalizeAgentCatalog({
    customTuiAgents: settings?.customTuiAgents,
    deletedCustomTuiAgents: settings?.deletedCustomTuiAgents,
    disabledTuiAgents: settings?.disabledTuiAgents,
    defaultTuiAgent: settings?.defaultTuiAgent
  })
  const failure = dispatchLaunchFailureForState(
    classifyRequestedState(identity.requestedAgent as TuiAgent, catalog)
  )
  if (!failure) {
    return { ok: true }
  }
  return {
    ok: false,
    error: `dispatch agent "${identity.requestedAgent}" is not launchable (${failure.code})`,
    launchFailure: {
      ...failure,
      version: 1,
      failureId: deps.mintFailureId(),
      intent: 'orchestration',
      occurredAt: deps.now()
    }
  }
}
