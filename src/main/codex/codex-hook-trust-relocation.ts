import type { HookCommandConfig, HookDefinition } from '../agent-hooks/installer-utils'
import {
  computeTrustedHash,
  computeTrustKey,
  normalizeHookTrustKeyForLookup,
  readHookTrustEntries,
  replaceHookTrustEntries,
  type CodexHookTrustState,
  type CodexTrustEntry
} from './config-toml-trust'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import { warnCodexConfigOnce } from './codex-config-toml-checked-edit'

type HookPosition = {
  eventName: string
  groupIndex: number
  handlerIndex: number
  definition: HookDefinition
  hook: HookCommandConfig
}

export type CodexHookTrustRelocationPlan = {
  /** Keys cleared before `carry` is written: moved handlers' old and new keys, removed Orca copies. */
  remove: string[]
  carry: CodexTrustEntry[]
  /** Old keys left alone because their trust could not be proven to belong to the handler. */
  refused: string[]
}

function listHookPositions(hooks: Record<string, HookDefinition[]>): HookPosition[] {
  return Object.entries(hooks).flatMap(([eventName, definitions]) =>
    (Array.isArray(definitions) ? definitions : []).flatMap((definition, groupIndex) =>
      (Array.isArray(definition.hooks) ? definition.hooks : []).map((hook, handlerIndex) => ({
        eventName,
        groupIndex,
        handlerIndex,
        definition,
        hook
      }))
    )
  )
}

function toTrustEntry(sourcePath: string, position: HookPosition): CodexTrustEntry | null {
  return createCodexHookTrustEntry(
    sourcePath,
    position.eventName,
    position.groupIndex,
    position.handlerIndex,
    position.definition,
    position.hook
  )
}

/**
 * Codex keys hooks.state by position, so a rewrite that removes or prepends
 * entries moves surviving handlers to keys with no trust. `after` must reuse
 * the handler objects of `before` (as removeManagedCommands does).
 */
export function planCodexHookTrustRelocation(args: {
  sourcePath: string
  before: Record<string, HookDefinition[]>
  after: Record<string, HookDefinition[]>
  existing: ReadonlyMap<string, CodexHookTrustState>
  /** Keys another writer owns after the rewrite (Orca's managed entries). */
  keepKeys: readonly string[]
}): CodexHookTrustRelocationPlan {
  const oldPositions = new Map<HookCommandConfig, HookPosition | null>()
  for (const position of listHookPositions(args.before)) {
    // Why: one handler object at two positions cannot be mapped to a single old key.
    oldPositions.set(position.hook, oldPositions.has(position.hook) ? null : position)
  }
  const plan: CodexHookTrustRelocationPlan = { remove: [], carry: [], refused: [] }
  const surviving = new Set<HookCommandConfig>()
  for (const position of listHookPositions(args.after)) {
    const old = oldPositions.get(position.hook)
    surviving.add(position.hook)
    if (old === null) {
      plan.refused.push(`${position.eventName}:${position.groupIndex}:${position.handlerIndex}`)
      continue
    }
    const oldEntry = old ? toTrustEntry(args.sourcePath, old) : null
    const newEntry = toTrustEntry(args.sourcePath, position)
    if (!oldEntry || !newEntry) {
      continue
    }
    const oldKey = computeTrustKey(oldEntry)
    const newKey = computeTrustKey(newEntry)
    const state = args.existing.get(oldKey)
    if (
      normalizeHookTrustKeyForLookup(oldKey) === normalizeHookTrustKeyForLookup(newKey) ||
      !state?.trustedHash
    ) {
      continue
    }
    // Why: a stale hash means the handler changed since approval; Codex must review it.
    if (state.trustedHash !== computeTrustedHash(oldEntry)) {
      plan.refused.push(oldKey)
      continue
    }
    plan.remove.push(oldKey, newKey)
    plan.carry.push({ ...newEntry, trustedHash: state.trustedHash, enabled: state.enabled })
  }
  for (const [hook, old] of oldPositions) {
    const entry = old && !surviving.has(hook) ? toTrustEntry(args.sourcePath, old) : null
    // Why: drop a removed copy's trust only when its hash proves the state is that copy's.
    if (
      entry &&
      args.existing.get(computeTrustKey(entry))?.trustedHash === computeTrustedHash(entry)
    ) {
      plan.remove.push(computeTrustKey(entry))
    }
  }
  const keep = new Set(args.keepKeys.map(normalizeHookTrustKeyForLookup))
  plan.remove = plan.remove.filter((key) => !keep.has(normalizeHookTrustKeyForLookup(key)))
  return plan
}

/** Carries the user's hook approvals across an Orca rewrite of a hooks.json; best effort, never throws. */
export function relocateCodexHookTrust(
  tomlPath: string,
  args: Omit<Parameters<typeof planCodexHookTrustRelocation>[0], 'existing'>
): void {
  try {
    const plan = planCodexHookTrustRelocation({
      ...args,
      existing: readHookTrustEntries(tomlPath)
    })
    if (plan.refused.length > 0) {
      warnCodexConfigOnce(
        tomlPath,
        `Left hook approvals at ${plan.refused.join(', ')} in ${tomlPath} as they were; Codex will ask to review those hooks.`
      )
    }
    if (plan.remove.length > 0 || plan.carry.length > 0) {
      replaceHookTrustEntries(tomlPath, plan.remove, plan.carry)
    }
  } catch (error) {
    warnCodexConfigOnce(
      tomlPath,
      `Could not carry hook approvals in ${tomlPath} across Orca's hooks.json update: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
