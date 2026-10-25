import { BUNDLED_AGENT_STATE_RULE_FILES } from './agent-state-rules-catalog'
import { BUNDLED_AGENT_STATE_RULES_VERSION } from './agent-state-rules-bundle'
import type { AgentStateRulesFile } from './agent-state-rules-schema'

/** Precedence: override, downloaded, bundled. */
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

export function activateAgentStateRules(next: ActiveAgentStateRules): void {
  active = next
}

/** Cache by file-array identity to keep unchanged-rule polling cheap. */
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
