// The single host-side minting point for an automation run's persisted
// launch-failure wrapper (ledger #12). Both failure arms — the renderer/headless
// dispatch result and the resolve-only classifier gate — carry a PLAIN
// AgentLaunchFailure; this stamps the host-authoritative wrapper before the
// store persists it, so there is exactly one place that can forge the
// comparison-keyed failureId and the client never mints it.

import { randomUUID } from 'node:crypto'
import type {
  AgentLaunchFailure,
  PersistedAgentLaunchFailure
} from '../../shared/agent-launch-contract'
import type {
  AutomationDispatchResult,
  AutomationRunPersistInput
} from '../../shared/automations-types'

/** Stamp the plain wire failure on a dispatch result into the store's persist
 *  input. Absent failure field → preserve (the store leaves the run's current
 *  failure untouched); present null → clear; present value → mint a fresh
 *  wrapper. Always mints anew so a re-submitted or client-minted wrapper cannot
 *  win over the host. */
export function stampAutomationDispatchLaunchFailure(
  result: AutomationDispatchResult
): AutomationRunPersistInput {
  if (!Object.hasOwn(result, 'agentLaunchFailure')) {
    const { agentLaunchFailure: _wireFailure, ...rest } = result
    return rest
  }
  const failure = result.agentLaunchFailure
  return {
    ...result,
    agentLaunchFailure: failure ? mintPersistedAutomationLaunchFailure(failure) : null
  }
}

/** Mint the host-authoritative persisted wrapper for the automation path.
 *  Whitelists the wire schema's fields — never spreads the client value, so a
 *  forged payload cannot smuggle extra keys into the persisted run. */
export function mintPersistedAutomationLaunchFailure(
  failure: AgentLaunchFailure
): PersistedAgentLaunchFailure {
  return {
    code: failure.code,
    ...(failure.requestedAgent !== undefined ? { requestedAgent: failure.requestedAgent } : {}),
    ...(failure.baseAgent !== undefined ? { baseAgent: failure.baseAgent } : {}),
    ...(failure.variable !== undefined ? { variable: failure.variable } : {}),
    ...(failure.field !== undefined ? { field: failure.field } : {}),
    ...(failure.shell !== undefined ? { shell: failure.shell } : {}),
    ...(failure.reason !== undefined ? { reason: failure.reason } : {}),
    version: 1,
    failureId: randomUUID(),
    intent: 'automation',
    occurredAt: Date.now()
  }
}
