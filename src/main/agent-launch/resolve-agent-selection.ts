// Agent selection and the lifecycle truth table. Given a request's selection,
// intent, and reference authority, this decides WHICH agent identity is launched
// and in what mode (built-in, custom, safe fallback, snapshot replay) or which
// typed failure/request-error is returned — the pure "who" of a launch, before
// any command/env assembly.

import type { BuiltInTuiAgent, TuiAgent } from '../../shared/types'
import { isBuiltInTuiAgent } from '../../shared/tui-agent-config'
import { isCustomTuiAgentId } from '../../shared/custom-tui-agent-identity'
import { TUI_AGENT_AUTO_PICK_ORDER } from '../../shared/tui-agent-selection'
import type { AgentCatalog } from '../../shared/agent-catalog-normalization'
import type {
  AgentReferenceAuthority,
  LaunchIntent,
  ResolveAgentLaunchRequest
} from '../../shared/agent-launch-host-contract'
import type {
  AgentLaunchFailure,
  AgentLaunchRequestError
} from '../../shared/agent-launch-contract'
import type { AdmissionFingerprintBasis } from './agent-launch-fingerprint'

/** Which lifecycle-table column applies, derived from intent + reference +
 *  snapshot presence. */
export type LifecycleColumn =
  | 'interactive-stored'
  | 'live-selection'
  | 'cli'
  | 'unattended'
  | 'resume-with-snapshot'
  | 'resume-without-snapshot'

export function classifyLifecycleColumn(
  intent: LaunchIntent,
  reference: AgentReferenceAuthority,
  hasSnapshot: boolean
): LifecycleColumn {
  if (intent.kind === 'resume') {
    return hasSnapshot ? 'resume-with-snapshot' : 'resume-without-snapshot'
  }
  if (intent.kind === 'cli') {
    return 'cli'
  }
  if (
    intent.kind === 'automation' ||
    intent.kind === 'background' ||
    intent.kind === 'orchestration'
  ) {
    return 'unattended'
  }
  // Interactive: only a host-proven persisted reference grants tombstone/fallback
  // authority; a live picker or raw-RPC value never does.
  return reference.kind === 'persisted' ? 'interactive-stored' : 'live-selection'
}

/** The mode/notice a launch decision carries once an identity is chosen. */
export type LaunchDecision =
  | { launch: 'built-in'; agent: BuiltInTuiAgent }
  | { launch: 'custom'; agent: TuiAgent; base: BuiltInTuiAgent }
  | {
      launch: 'safe-fallback'
      requestedAgent: TuiAgent
      base: BuiltInTuiAgent
      notice: 'missing_custom_fallback' | 'disabled_custom_fallback'
    }
  | { launch: 'replay-snapshot'; agent: TuiAgent; base: BuiltInTuiAgent }

export type SelectionOutcome =
  | { kind: 'decision'; decision: LaunchDecision; basis: AdmissionFingerprintBasis }
  | { kind: 'failure'; failure: AgentLaunchFailure }
  | { kind: 'request-error'; requestError: AgentLaunchRequestError }

/** Auto-pick: first effectively-enabled built-in in canonical order that is
 *  concretely detected. Unknown detection (null) skips the detection filter to
 *  preserve shipped behavior; a concrete empty set yields no agent. */
function autoPickBuiltIn(
  catalog: AgentCatalog,
  detected: ReadonlySet<BuiltInTuiAgent> | null
): BuiltInTuiAgent | null {
  for (const agent of TUI_AGENT_AUTO_PICK_ORDER) {
    if (catalog.disabledAgents.has(agent)) {
      continue
    }
    if (detected !== null && !detected.has(agent)) {
      continue
    }
    return agent
  }
  return null
}

export type RequestedState =
  | { state: 'enabled-built-in'; base: BuiltInTuiAgent }
  | { state: 'disabled-built-in'; base: BuiltInTuiAgent }
  | { state: 'enabled-custom'; agent: TuiAgent; base: BuiltInTuiAgent }
  | { state: 'disabled-custom'; agent: TuiAgent; base: BuiltInTuiAgent }
  | { state: 'repair-required'; agent: TuiAgent; base: BuiltInTuiAgent }
  | { state: 'missing-with-tombstone'; agent: TuiAgent; base: BuiltInTuiAgent }
  | { state: 'missing-no-tombstone'; agent: TuiAgent }
  | { state: 'base-disabled'; agent: TuiAgent; base: BuiltInTuiAgent }

export function classifyRequestedState(agent: TuiAgent, catalog: AgentCatalog): RequestedState {
  if (isBuiltInTuiAgent(agent)) {
    return catalog.disabledAgents.has(agent)
      ? { state: 'disabled-built-in', base: agent }
      : { state: 'enabled-built-in', base: agent }
  }
  if (!isCustomTuiAgentId(agent)) {
    return { state: 'missing-no-tombstone', agent }
  }
  const live = catalog.liveById.get(agent)
  if (live) {
    const base = live.baseAgent
    if (catalog.disabledAgents.has(base)) {
      return { state: 'base-disabled', agent, base }
    }
    return catalog.disabledAgents.has(agent)
      ? { state: 'disabled-custom', agent, base }
      : { state: 'enabled-custom', agent, base }
  }
  const repair = catalog.repairRequiredById.get(agent)
  if (repair && repair.baseAgent) {
    const base = repair.baseAgent
    if (catalog.disabledAgents.has(base)) {
      return { state: 'base-disabled', agent, base }
    }
    return { state: 'repair-required', agent, base }
  }
  const tombstone = catalog.tombstonesById.get(agent)
  if (tombstone) {
    const base = tombstone.baseAgent
    if (catalog.disabledAgents.has(base)) {
      return { state: 'base-disabled', agent, base }
    }
    return { state: 'missing-with-tombstone', agent, base }
  }
  return { state: 'missing-no-tombstone', agent }
}

function evaluateLifecycle(
  requested: RequestedState,
  column: LifecycleColumn,
  basis: AdmissionFingerprintBasis
): SelectionOutcome {
  const decide = (d: LaunchDecision): SelectionOutcome => ({ kind: 'decision', decision: d, basis })
  const fail = (failure: AgentLaunchFailure): SelectionOutcome => ({ kind: 'failure', failure })

  // Base-disable precedence wins over custom-disabled/missing/repair everywhere.
  if (requested.state === 'base-disabled' || requested.state === 'disabled-built-in') {
    return fail({ code: 'base_agent_disabled', baseAgent: requested.base })
  }

  if (requested.state === 'enabled-built-in') {
    return decide({ launch: 'built-in', agent: requested.base })
  }

  if (requested.state === 'repair-required') {
    return fail({ code: 'agent_definition_needs_repair', requestedAgent: requested.agent })
  }

  if (requested.state === 'enabled-custom') {
    return decide({ launch: 'custom', agent: requested.agent, base: requested.base })
  }

  if (requested.state === 'disabled-custom') {
    if (column === 'interactive-stored' || column === 'resume-without-snapshot') {
      return decide({
        launch: 'safe-fallback',
        requestedAgent: requested.agent,
        base: requested.base,
        notice: 'disabled_custom_fallback'
      })
    }
    return fail({ code: 'custom_agent_disabled', requestedAgent: requested.agent })
  }

  if (requested.state === 'missing-with-tombstone') {
    if (column === 'interactive-stored' || column === 'resume-without-snapshot') {
      return decide({
        launch: 'safe-fallback',
        requestedAgent: requested.agent,
        base: requested.base,
        notice: 'missing_custom_fallback'
      })
    }
    if (column === 'live-selection') {
      // A live picker/raw-RPC value carries no fallback authority: reject the
      // request without persisting any launch-attempt state.
      return { kind: 'request-error', requestError: { code: 'untrusted_reference' } }
    }
    return fail({ code: 'unknown_agent', requestedAgent: requested.agent })
  }

  return fail({ code: 'unknown_agent', requestedAgent: requested.agent })
}

/** Resume-with-snapshot short-circuits the catalog-derived lifecycle: the
 *  snapshot is the identity/argv authority. Only a disabled base blocks replay
 *  here; full snapshot field validation happens in the command stage. */
function resolveSnapshotReplay(
  request: ResolveAgentLaunchRequest,
  catalog: AgentCatalog
): SelectionOutcome {
  const snapshot = request.persistedSnapshot
  if (!snapshot) {
    return { kind: 'failure', failure: { code: 'invalid_launch_snapshot' } }
  }
  if (catalog.disabledAgents.has(snapshot.baseAgent)) {
    return {
      kind: 'failure',
      failure: { code: 'base_agent_disabled', baseAgent: snapshot.baseAgent }
    }
  }
  return {
    kind: 'decision',
    decision: {
      launch: 'replay-snapshot',
      agent: snapshot.requestedAgent,
      base: snapshot.baseAgent
    },
    basis: 'snapshot'
  }
}

/** Resolve the selection to a launch decision or a typed failure/request-error.
 *  Does not assemble the command/env — only chooses the identity and mode. */
export function resolveSelection(
  request: ResolveAgentLaunchRequest,
  catalog: AgentCatalog
): SelectionOutcome {
  const column = classifyLifecycleColumn(
    request.intent,
    request.reference,
    request.persistedSnapshot !== undefined
  )

  if (column === 'resume-with-snapshot') {
    return resolveSnapshotReplay(request, catalog)
  }

  if (request.selection.kind === 'default') {
    const stored = catalog.defaultAgent
    if (stored === 'auto') {
      const picked = autoPickBuiltIn(catalog, request.detectedStockBaseAgents)
      if (!picked) {
        return { kind: 'failure', failure: { code: 'no_agent_selected' } }
      }
      return evaluateLifecycle(classifyRequestedState(picked, catalog), column, 'default')
    }
    // 'blank' and null are agent-required failures with the same code; null also
    // implies repair attention, surfaced by the same no_agent_selected outcome.
    if (stored === 'blank' || stored === null) {
      return { kind: 'failure', failure: { code: 'no_agent_selected' } }
    }
    return evaluateLifecycle(classifyRequestedState(stored, catalog), column, 'default')
  }

  return evaluateLifecycle(
    classifyRequestedState(request.selection.agent, catalog),
    column,
    'explicit'
  )
}
