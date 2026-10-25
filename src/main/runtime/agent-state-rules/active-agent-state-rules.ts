import { BUNDLED_AGENT_STATE_RULE_FILES } from './agent-state-rules-catalog'
import { BUNDLED_AGENT_STATE_RULES_VERSION } from './agent-state-rules-bundle'
import type { AgentStateRulesFile } from './agent-state-rules-schema'

/** Where the rules in use came from: precedence is override, then downloaded, then bundled. */
export type AgentStateRulesSource = 'bundled' | 'downloaded' | 'override'

export type ActiveAgentStateRules = {
  files: readonly AgentStateRulesFile[]
  version: number
  source: AgentStateRulesSource
}

export const BUNDLED_AGENT_STATE_RULES: ActiveAgentStateRules = {
  files: BUNDLED_AGENT_STATE_RULE_FILES,
  version: BUNDLED_AGENT_STATE_RULES_VERSION,
  source: 'bundled'
}

let active = BUNDLED_AGENT_STATE_RULES

/** Replaces the bundled files of the same id; an agent the bundle does not name keeps its own. */
export function overlayOnBundledAgentStateRules(
  files: readonly AgentStateRulesFile[]
): readonly AgentStateRulesFile[] {
  const byId = new Map(files.map((file) => [file.id, file]))
  const merged = BUNDLED_AGENT_STATE_RULES.files.map((file) => byId.get(file.id) ?? file)
  const bundledIds = new Set(BUNDLED_AGENT_STATE_RULES.files.map((file) => file.id))
  return [...merged, ...files.filter((file) => !bundledIds.has(file.id))]
}

export function getActiveAgentStateRules(): ActiveAgentStateRules {
  return active
}

/** Hot reload: every compiled view below recompiles from `next` on its next read. */
export function activateAgentStateRules(next: ActiveAgentStateRules): void {
  active = next
}

/**
 * A view compiled from the active files, rebuilt only when they change. Why keyed on the array:
 * readers run on every poll, and one identity check is all a stable rule set costs them.
 */
export function compiledFromActiveAgentStateRules<T>(
  compile: (files: readonly AgentStateRulesFile[]) => T
): () => T {
  let compiled: { files: readonly AgentStateRulesFile[]; value: T } | null = null
  return () => {
    if (compiled?.files !== active.files) {
      compiled = { files: active.files, value: compile(active.files) }
    }
    return compiled.value
  }
}
