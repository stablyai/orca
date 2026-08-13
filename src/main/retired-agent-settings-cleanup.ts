// Why: a removed agent id outlives its code inside saved profiles. Most readers
// guard with isTuiAgent(), but `defaultTuiAgent` preselects the launch target
// verbatim, Source Control AI copies its `agentId` into every action recipe,
// and automations dispatch with a raw agentId — all would point at an agent
// that no longer exists. Scrub the profile once at the load boundary so no
// downstream reader has to.

import type { PersistedState } from '../shared/types'

/** Agent ids Orca no longer ships. Keep an entry until profiles predating its removal are gone. */
const RETIRED_AGENTS: readonly unknown[] = ['gemini']

/** Status-bar providers Orca no longer publishes usage for. */
const RETIRED_STATUS_BAR_ITEMS: readonly unknown[] = ['gemini', 'antigravity']

/** GlobalSettings keys owned solely by a retired agent. */
const RETIRED_KEYS: readonly string[] = ['geminiCliOAuthEnabled']

/** Single-agent fields. null reads as "fall back to the default" everywhere. */
const AGENT_ID_KEYS: readonly string[] = ['agentId', 'defaultTuiAgent']

// Why: named explicitly rather than detected, so a repo, host, or worktree
// literally called "gemini" is never mistaken for an agent-keyed map.
const AGENT_KEYED_MAPS: readonly string[] = [
  'agentCmdOverrides',
  'agentDefaultArgs',
  'agentDefaultEnv',
  'selectedModelByAgent',
  'discoveredModelsByAgent'
]
const AGENT_KEYED_MAPS_BY_HOST: readonly string[] = [
  'selectedModelByAgentByHost',
  'discoveredModelsByAgentByHost'
]

type Rec = Record<string, unknown>

function asRecord(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null
}

/** Every mutator reports whether it touched anything, so the dirty check costs
 *  one walk instead of serializing the whole profile twice per launch. */
function dropRetiredKeys(value: unknown): boolean {
  const record = asRecord(value)
  let changed = false
  for (const key of Object.keys(record ?? {})) {
    if (RETIRED_AGENTS.includes(key)) {
      delete record![key]
      changed = true
    }
  }
  return changed
}

function filterRetired(
  record: Rec,
  key: string,
  values: unknown[],
  retired: readonly unknown[]
): boolean {
  const kept = values.filter((value) => !retired.includes(value))
  if (kept.length === values.length) {
    return false
  }
  record[key] = kept
  return true
}

/**
 * One depth-first pass over the profile. Every shape that stores an agent id
 * does it under one of the key names above, at some nesting depth that differs
 * per shape (settings, per-repo overrides, action recipes, automations), so
 * matching on the key rather than the path covers them all.
 */
function scrub(node: unknown): boolean {
  if (Array.isArray(node)) {
    // Why not .some(): short-circuiting would skip the rest of the array.
    return node.reduce<boolean>((changed, entry) => scrub(entry) || changed, false)
  }
  const record = asRecord(node)
  if (!record) {
    return false
  }
  let changed = false
  for (const [key, value] of Object.entries(record)) {
    if (RETIRED_KEYS.includes(key)) {
      delete record[key]
      changed = true
    } else if (AGENT_ID_KEYS.includes(key) && RETIRED_AGENTS.includes(value)) {
      record[key] = null
      changed = true
    } else if (key === 'createdWithAgent' && RETIRED_AGENTS.includes(value)) {
      delete record[key]
      changed = true
    } else if (key === 'disabledTuiAgents' && Array.isArray(value)) {
      changed = filterRetired(record, key, value, RETIRED_AGENTS) || changed
    } else if (key === 'statusBarItems' && Array.isArray(value)) {
      changed = filterRetired(record, key, value, RETIRED_STATUS_BAR_ITEMS) || changed
    } else if (AGENT_KEYED_MAPS.includes(key)) {
      changed = dropRetiredKeys(value) || changed
    } else if (AGENT_KEYED_MAPS_BY_HOST.includes(key)) {
      for (const perHost of Object.values(asRecord(value) ?? {})) {
        changed = dropRetiredKeys(perHost) || changed
      }
    } else {
      changed = scrub(value) || changed
    }
  }
  return changed
}

/**
 * Rewrites `state` in place. Returns true when anything changed, so the caller
 * can flag the profile for a re-save.
 */
export function cleanRetiredAgentReferences(state: PersistedState): boolean {
  let changed = false
  // Why: automations dispatch without the isTuiAgent() guard most readers apply,
  // so clearing the id alone would let them run on whatever agent is default.
  // Scoped to automations on purpose — commitMessageAi also has an `enabled`
  // flag, but there a cleared agent must not switch the whole feature off.
  for (const automation of state.automations ?? []) {
    if (automation && RETIRED_AGENTS.includes(automation.agentId) && automation.enabled !== false) {
      automation.enabled = false
      changed = true
    }
  }
  return scrub(state) || changed
}
