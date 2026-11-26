// The custom ACP agents this host's settings define, kept current as the settings change.

import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import {
  isCustomAcpAgentId,
  normalizeCustomAcpAgents,
  type CustomAcpAgent
} from '../../../shared/agent-launch/custom-acp/custom-acp-agent'
import { customAcpLaunchSpec } from './custom-acp-launch-spec'
import { setConfiguredAgentLabelSource } from '../../../shared/agent-status/presentation/agent-type-label'

type Entry = { agent: CustomAcpAgent; spec: AcpLaunchSpec }

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

function sameAgent(a: CustomAcpAgent, b: CustomAcpAgent): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Applies saved settings. An edited agent keeps its spec object, so adapters and metadata built
 *  from it launch the new command next time; a removed agent stops being registered. */
export function syncCustomAcpAgents(saved: unknown): void {
  const next = normalizeCustomAcpAgents(saved)
  let changed = next.length !== entries.size
  const kept = new Set<string>()
  for (const agent of next) {
    kept.add(agent.id)
    const entry = entries.get(agent.id)
    if (!entry) {
      entries.set(agent.id, { agent, spec: customAcpLaunchSpec(agent) })
      changed = true
    } else if (!sameAgent(entry.agent, agent)) {
      Object.assign(entry.spec, customAcpLaunchSpec(agent))
      entry.agent = agent
      changed = true
    }
  }
  for (const id of entries.keys()) {
    if (!kept.has(id)) {
      entries.delete(id)
      changed = true
    }
  }
  if (changed) {
    listeners.forEach((listener) => listener())
  }
}

export function customAcpLaunchSpecFor(agent: string): AcpLaunchSpec | null {
  return isCustomAcpAgentId(agent) ? (entries.get(agent)?.spec ?? null) : null
}

export function customAcpAgentName(agent: string): string | null {
  return isCustomAcpAgentId(agent) ? (entries.get(agent)?.agent.name ?? null) : null
}

// Chat names and notices made here use the agent's name, not its id.
setConfiguredAgentLabelSource(customAcpAgentName)

/** Whether the host's settings switched a custom agent off for new chats. */
export function customAcpAgentDisabled(agent: string): boolean {
  return isCustomAcpAgentId(agent) && entries.get(agent)?.agent.disabled === true
}

export function listCustomAcpAgents(): readonly CustomAcpAgent[] {
  return [...entries.values()].map(({ agent }) => agent)
}

export function onCustomAcpAgentsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Follows the store's saved agents for as long as the runtime holds it; returns the release. */
export function installCustomAcpAgentSettings(
  store: Pick<RuntimeStore, 'getSettings' | 'onSettingsChanged'> | null
): () => void {
  if (!store) {
    return () => {}
  }
  syncCustomAcpAgents(store.getSettings().customAcpAgents)
  return (
    store.onSettingsChanged?.((updates, settings) => {
      if ('customAcpAgents' in updates) {
        syncCustomAcpAgents(settings.customAcpAgents)
      }
    }) ?? (() => {})
  )
}
