// Why (#8711): the managed-hook install RPC used to answer with counts that the
// client threw away after a console.warn, so `agent hooks status` had nothing to
// say about the host that actually runs the agent. This turns one relay answer
// into the host outcome the diagnostic prints — and keeps a pre-#8711 relay,
// which answers without `statuses`, from reading as a clean install.

import {
  summarizeAgentHookHostState,
  type AgentHookHostOutcome
} from '../../shared/agent-hook-host-status'
import { AGENT_HOOK_TARGETS, type AgentHookInstallStatus } from '../../shared/agent-hook-types'

const INSTALL_STATES = new Set(['installed', 'not_installed', 'partial', 'error', 'skipped'])
const AGENTS = new Set<string>(AGENT_HOOK_TARGETS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStatus(value: unknown): AgentHookInstallStatus | null {
  if (!isRecord(value)) {
    return null
  }
  const { agent, state } = value
  if (typeof agent !== 'string' || !AGENTS.has(agent)) {
    return null
  }
  if (typeof state !== 'string' || !INSTALL_STATES.has(state)) {
    return null
  }
  return {
    agent: agent as AgentHookInstallStatus['agent'],
    state: state as AgentHookInstallStatus['state'],
    configPath: typeof value.configPath === 'string' ? value.configPath : '',
    managedHooksPresent: value.managedHooksPresent === true,
    detail: typeof value.detail === 'string' ? value.detail : null,
    ...(typeof value.skipReason === 'string'
      ? { skipReason: value.skipReason as AgentHookInstallStatus['skipReason'] }
      : {})
  }
}

export function readManagedHookInstallOutcome(result: unknown): AgentHookHostOutcome {
  if (!isRecord(result)) {
    return { state: 'unknown', detail: 'Remote host returned no install result.', statuses: [] }
  }
  const reportedStatuses = Array.isArray(result.statuses) ? result.statuses : null
  const statuses = (reportedStatuses ?? []).flatMap((entry) => {
    const parsed = parseStatus(entry)
    return parsed ? [parsed] : []
  })
  // Why: a host that answered with per-agent results Orca cannot read is a host
  // Orca did not understand — falling back to the counts would let a garbled
  // answer print as a clean install, which is the bug this whole path fixes.
  if (reportedStatuses !== null && reportedStatuses.length > 0 && statuses.length === 0) {
    return {
      state: 'unknown',
      detail: 'Remote host reported managed hook results Orca could not read.',
      statuses: []
    }
  }
  if (statuses.length > 0) {
    const state = summarizeAgentHookHostState(statuses)
    const failed = statuses.filter((status) => status.state === 'error')
    return {
      state,
      detail:
        failed.length > 0 ? `${failed.length} agent hook install(s) failed on this host.` : null,
      statuses
    }
  }
  // Why: a relay that predates the per-agent field still answers with counts.
  // They are enough for a host verdict but not for a per-agent breakdown, and
  // an install that ran zero installers is not an install that succeeded.
  const errors = typeof result.errors === 'number' ? result.errors : null
  const installers = typeof result.installers === 'number' ? result.installers : null
  if (errors === null || installers === null) {
    return {
      state: 'unknown',
      detail: 'Remote host did not report managed hook install results.',
      statuses: []
    }
  }
  if (installers === 0) {
    return { state: 'skipped', detail: 'No managed agent hooks were installed.', statuses: [] }
  }
  if (errors === 0) {
    return {
      state: 'installed',
      detail: `${installers} agent hook install(s) reported by an older remote runtime.`,
      statuses: []
    }
  }
  return {
    state: errors >= installers ? 'error' : 'partial',
    detail: `${errors} of ${installers} agent hook install(s) failed on this host.`,
    statuses: []
  }
}
