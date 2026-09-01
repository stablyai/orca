// Snapshot definition-drift comparison, evaluated inside the resolver's replay
// path (I15: pure, no I/O). Before replay the resolver checks whether the
// requested agent's CURRENT effective definition still matches the captured
// snapshot; if not, it emits `snapshot_definition_changed`. A disabled, deleted,
// tombstoned, repair-required, or base-disabled definition has no current
// effective config, so it counts as differing (the lifecycle table's
// disabled/missing replay rows always carry the notice). Desktop/host replay
// compares label + argv + full agent env (keys AND values); mobile/paired-web
// compares label + argv + captured-vs-current env policy state only, never env
// keys/values, so a value-only edit cannot leak through the comparison.

import type { GlobalSettings } from '../../shared/types'
import type { AgentCatalog } from '../../shared/agent-catalog-normalization'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import type { AgentLaunchNotice } from '../../shared/agent-launch-contract'
import { classifyRequestedState } from './resolve-agent-selection'
import { buildLaunchContext } from './resolve-agent-launch-context'
import { assembleCommand } from './resolve-agent-command'
import { interpolateVariables, prepareVariableValues } from './resolve-agent-variables'
import type { LaunchClientKind } from './resolve-agent-env-admission'
import type { LaunchTarget } from './resolve-agent-launch-result'

type CurrentEffectiveDefinition = {
  displayLabel: string
  argv: readonly string[]
  env: Record<string, string>
  envPolicy: 'full' | 'withheld' | 'none'
}

export type SnapshotComparisonInput = {
  snapshot: AgentLaunchSnapshot
  catalog: AgentCatalog
  settings: GlobalSettings
  target: LaunchTarget
  client: LaunchClientKind
  variables: { repoPath?: string | null; worktreePath?: string | null }
  targetHomePath: string | null
}

/** Resolve the requested agent's current effective definition, or null when it
 *  is unavailable (disabled/deleted/tombstoned/repair/base-disabled, or its
 *  current args no longer assemble). Assembled with the resume request's own
 *  worktree variables; resume is same-worktree, so path values match capture and
 *  any argv difference reflects a definition change, not a path move. */
function resolveCurrentEffectiveDefinition(
  input: SnapshotComparisonInput
): CurrentEffectiveDefinition | null {
  const state = classifyRequestedState(input.snapshot.requestedAgent, input.catalog)
  const decision =
    state.state === 'enabled-built-in'
      ? ({ launch: 'built-in', agent: state.base } as const)
      : state.state === 'enabled-custom'
        ? ({ launch: 'custom', agent: state.agent, base: state.base } as const)
        : null
  if (!decision) {
    return null
  }
  const context = buildLaunchContext(decision, input.catalog, input.settings, input.client)
  const values = prepareVariableValues(input.variables, input.target.execution)
  const command = assembleCommand({
    config: context.config,
    platform: input.target.platform,
    isRemote: input.target.isRemote,
    shell: input.target.shell,
    targetHomePath: input.targetHomePath,
    commandOverride: context.commandOverride,
    prefixOverride: context.prefixOverride,
    argsTemplate: context.argsTemplate,
    isCustomArgs: context.isCustomArgs,
    // NOTE (L3b-#4, follow-up): the admitted snapshot bakes the U7 per-launch recipe
    // args into argv but does not persist the band separately, so a recipe-driven
    // resume still reads as definition-changed here. The correct fix is an additive
    // `perLaunchArgs` field on the durable AgentLaunchSnapshot (+capture) threaded in
    // here; deferred to keep this change off the durable-schema path.
    envValues: Object.keys(context.env).map((key) => context.env[key]),
    values
  })
  if (!command.ok) {
    return null
  }
  // Mirror resolve-agent-launch: the captured snapshot env is interpolated, so the
  // current env must be interpolated with the same (same-worktree) values or every
  // resume of an agent with a {worktreePath}/{repoPath} env value would falsely read
  // as definition-changed (and mobile remove-only replay would withhold it).
  const resolvedEnv: Record<string, string> = {}
  for (const key of Object.keys(context.env)) {
    resolvedEnv[key] = interpolateVariables(context.env[key], values)
  }
  return {
    displayLabel: context.displayLabel,
    argv: command.argv,
    env: resolvedEnv,
    envPolicy: context.envPolicy
  }
}

function argvEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

function agentEnvEquals(a: Readonly<Record<string, string>>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) {
    return false
  }
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key) || a[key] !== b[key]) {
      return false
    }
  }
  return true
}

function definitionMatchesSnapshot(
  snapshot: AgentLaunchSnapshot,
  current: CurrentEffectiveDefinition,
  client: LaunchClientKind
): boolean {
  if (snapshot.displayLabel !== current.displayLabel || !argvEquals(snapshot.argv, current.argv)) {
    return false
  }
  // Mobile/paired-web must never see env keys/values in the comparison, so it
  // considers only the captured-vs-current env policy state; a value-only edit is
  // handled by the remove-only replay + env_withheld path, not this notice.
  if (client === 'mobile' || client === 'paired-web') {
    return snapshot.capturedEnvPolicy === current.envPolicy
  }
  return agentEnvEquals(snapshot.agentEnv, current.env)
}

export type MobileReplayEnvResult = { env: Record<string, string>; withheld: boolean }

/** Mobile/paired-web remove-only env replay (§581): keep a captured entry only
 *  when the CURRENT live definition still authorizes it — its admitted env
 *  (syncEnv on) still contains the same key (case-insensitive on Windows) with
 *  the SAME value. A removed key, a rotated value, an opt-out (syncEnv off →
 *  empty admitted env), or a missing/deleted definition withholds that entry.
 *  Withheld entries are never substituted with current values, and current
 *  entries absent from the snapshot are never added; the source snapshot is not
 *  mutated. Any withholding raises a single env_withheld notice at the call site.
 *  Desktop/host replay does NOT use this — it copies the captured env unchanged. */
export function resolveMobileRemoveOnlyReplayEnv(
  input: SnapshotComparisonInput
): MobileReplayEnvResult {
  const current = resolveCurrentEffectiveDefinition(input)
  const currentEnv = current?.env ?? {}
  const caseInsensitive = input.target.platform === 'win32'
  const currentLookup = caseInsensitive ? lowercaseKeyed(currentEnv) : currentEnv
  const env: Record<string, string> = {}
  let withheld = false
  for (const key of Object.keys(input.snapshot.agentEnv)) {
    const lookupKey = caseInsensitive ? key.toLowerCase() : key
    const currentValue = Object.hasOwn(currentLookup, lookupKey)
      ? currentLookup[lookupKey]
      : undefined
    if (currentValue !== undefined && currentValue === input.snapshot.agentEnv[key]) {
      env[key] = input.snapshot.agentEnv[key]
    } else {
      withheld = true
    }
  }
  return { env, withheld }
}

function lowercaseKeyed(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(env)) {
    out[key.toLowerCase()] = env[key]
  }
  return out
}

/** The `snapshot_definition_changed` notice when the current effective
 *  definition differs from the snapshot, or null when they match. */
export function snapshotDefinitionChangedNotice(
  input: SnapshotComparisonInput
): AgentLaunchNotice | null {
  const current = resolveCurrentEffectiveDefinition(input)
  const matches =
    current !== null && definitionMatchesSnapshot(input.snapshot, current, input.client)
  return matches
    ? null
    : { code: 'snapshot_definition_changed', label: input.snapshot.displayLabel }
}
