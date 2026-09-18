import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import { getAgentModelProbeSpec } from '../../../../../../shared/agent-model-probe-spec'
import {
  findCatalogModel,
  findCatalogOption,
  getAgentSessionOptionCatalog
} from '../../../../../../shared/agent-session-option-catalog'
import { resolveAgentSessionOptionLaunch } from '../../../../../../shared/agent-session-option-launch'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  discoverCommitMessageModelsLocal,
  type DiscoverCommitMessageModelsResult
} from '../../../../../text-generation/commit-message-text-generation'

export type OrchestrationWorkerLaunchSelection = {
  agent: TuiAgent | null
  model: string | null
  effort: string | null
}

/** How `effective` was determined (issue #10846 — `effective` must never be a
 *  silent clone of `requested`):
 *  - 'probe': the installed CLI was asked (list_models) and its own answer
 *    (`catalogOrigin: 'probe'`) named this exact model; see `effortSource` for
 *    whether effort was probed too.
 *  - 'catalog': either no live probe runs for this agent, or the probe ran but
 *    the CLI exited cleanly with no parseable model list, so discovery fell
 *    back to the static catalog (`catalogOrigin: 'spec'`, I4) — `effective` is
 *    the request as validated against the static catalog only, an honest
 *    label, not a claim of live verification.
 *  - 'unverified': a probe exists but could not be run (not on PATH, timed
 *    out, too much output, ...); `unverifiedReason` carries the CLI/spawn
 *    failure text. The worker still starts on the catalog floor. */
export type OrchestrationWorkerLaunchSource = 'probe' | 'catalog' | 'unverified'

export type OrchestrationWorkerLaunchReceipt = {
  requested: OrchestrationWorkerLaunchSelection
  effective: OrchestrationWorkerLaunchSelection | null
  /** Absent on receipts from an older host, or from a caller that never
   *  verifies (the federated coordinator's own preliminary receipt) — never
   *  assume 'probe' when this is missing. */
  source?: OrchestrationWorkerLaunchSource
  /** Set only when `source` is 'unverified'. */
  unverifiedReason?: string
  /** Set only when `source` is 'probe' and an effort was requested but validated against
   *  the static catalog rather than the CLI's own probe answer. Codex's `debug models`
   *  reports per-model reasoning levels, but never advertises 'minimal', which the static
   *  catalog (agent-session-option-catalog-claude-codex.ts) offers as every model's floor —
   *  trusting the probe for effort would reject a selection the catalog calls valid. Model
   *  is still fully probe-verified; only effort falls back to the catalog (I2). Cursor is the
   *  same: its probe's `thinkingLevels` heuristic doesn't cover every model that carries a real
   *  `effort` option in CURSOR_SESSION_OPTION_CATALOG (I3). */
  effortSource?: 'catalog'
}

export function createWorkerLaunchReceipt(args: {
  agent: TuiAgent | null
  model?: string
  effort?: string
}): OrchestrationWorkerLaunchReceipt {
  const selection = {
    agent: args.agent,
    model: args.model ?? null,
    effort: args.effort ?? null
  }
  return { requested: selection, effective: { ...selection } }
}

export function createPendingWorkerLaunchReceipt(args: {
  agent: TuiAgent | null
  model?: string
  effort?: string
}): OrchestrationWorkerLaunchReceipt {
  return {
    requested: {
      agent: args.agent,
      model: args.model ?? null,
      effort: args.effort ?? null
    },
    effective: null
  }
}

/** The existing local model-discovery executor (commit-message-model-discovery.ts's
 *  discoverModelsLocal, already wired to spawnSourceControlAgent) — reused here, for every
 *  probeable agent, rather than a new spawner. Test seam: production always passes the real
 *  function, whose identity is the coalescing key below. */
export type AgentLaunchModelDiscovery = typeof discoverCommitMessageModelsLocal

type AgentLaunchVerification =
  | { outcome: 'accepted'; catalogOrigin: 'probe' | 'spec'; effortSource?: 'catalog' }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unverified'; reason: string }

// Why: coalesce concurrent/repeated probes for the process lifetime, like
// native-chat-session-option-enrichment.ts's per-(agent,host) cache does. Keying
// on the executor's own identity (with a nested per-agent entry, since one production
// executor now serves every probeable agent) means production shares one probe per
// agent, while each test's fresh stub gets its own entries — no explicit reset needed
// between tests.
const agentModelProbeByExecutor = new WeakMap<
  AgentLaunchModelDiscovery,
  Map<TuiAgent, Promise<DiscoverCommitMessageModelsResult>>
>()

function probeAgentModelsOnce(
  agentId: TuiAgent,
  discover: AgentLaunchModelDiscovery
): Promise<DiscoverCommitMessageModelsResult> {
  let byAgent = agentModelProbeByExecutor.get(discover)
  if (!byAgent) {
    byAgent = new Map()
    agentModelProbeByExecutor.set(discover, byAgent)
  }
  let pending = byAgent.get(agentId)
  if (!pending) {
    // Why: model discovery is a CLI-binary capability check, not a per-worktree
    // git operation — the default environment is enough to ask "what does the
    // installed CLI accept", so no cwd/wsl routing is threaded through here.
    pending = discover(agentId, process.env)
    // I4: only a successful probe is worth memoising for the process lifetime. A transient
    // miss (CLI briefly unreachable, a timeout) must not pin every later worker-start for this
    // agent to 'unverified' forever -- evict on failure (resolved false, or a thrown rejection)
    // so the next launch re-probes.
    pending
      .then((result) => {
        if (!result.success && byAgent!.get(agentId) === pending) {
          byAgent!.delete(agentId)
        }
      })
      .catch(() => {
        if (byAgent!.get(agentId) === pending) {
          byAgent!.delete(agentId)
        }
      })
    byAgent.set(agentId, pending)
  }
  return pending
}

/** @param verifyEffortAgainstProbe Claude's probe reports reliable per-model effort levels
 *  (thinkingLevels), so its effort is checked against the probe too. Codex's probe reports
 *  per-model reasoning levels as well, but the set never includes 'minimal', which the static
 *  catalog offers as every model's universal floor (agent-session-option-catalog-claude-codex.ts)
 *  — checking effort against Codex's probe would reject a catalog-valid selection no real model
 *  has ever been asked to support. Pass false there: model is still fully verified, effort falls
 *  back to the catalog and the receipt says so via `effortSource`. */
async function verifyAgentLaunchSelection(
  agentId: TuiAgent,
  model: string,
  effort: string | undefined,
  discover: AgentLaunchModelDiscovery,
  verifyEffortAgainstProbe: boolean
): Promise<AgentLaunchVerification> {
  const result = await probeAgentModelsOnce(agentId, discover)
  if (!result.success) {
    return { outcome: 'unverified', reason: result.error }
  }
  const label = getAgentModelProbeSpec(agentId)?.label ?? agentId
  const listed = result.models.find((candidate) => candidate.id === model)
  if (!listed) {
    const available = result.models.map((candidate) => candidate.id).join(', ') || 'none'
    return {
      outcome: 'rejected',
      reason: `The installed ${label} CLI does not list model "${model}". Available: ${available}.`
    }
  }
  if (effort) {
    if (!verifyEffortAgainstProbe) {
      return { outcome: 'accepted', catalogOrigin: result.catalogOrigin, effortSource: 'catalog' }
    }
    const levels = listed.thinkingLevels ?? []
    if (!levels.some((level) => level.id === effort)) {
      const available = levels.map((level) => level.id).join(', ') || 'none'
      return {
        outcome: 'rejected',
        reason: `The installed ${label} CLI's "${model}" does not accept effort "${effort}". Available: ${available}.`
      }
    }
  }
  return { outcome: 'accepted', catalogOrigin: result.catalogOrigin }
}

/** Agents whose worker launch preferences are probed against the installed CLI (I / I2 / I3).
 *  Cursor reuses the same `getAgentModelProbeSpec('cursor')` entry
 *  (`commit-message-agent-specs-secondary.ts`, `cursor-agent --list-models`) that already backs
 *  commit-message generation — no parallel probe. Grok is deliberately absent:
 *  `GROK_SESSION_OPTION_CATALOG` has no `supportsWorkerLaunchPreferences`, so a grok
 *  `--model`/`--effort` worker-start is already rejected above (`does not support launch-time
 *  model selection`) before this function ever dispatches on the agent — there is no receipt
 *  here for grok's model-list probe to attach to. That probe is wired and tested at the
 *  discovery layer (`agent-model-probe-spec.ts`, `grok-model-list-probe.ts`) so it's ready the
 *  day grok's catalog opts in. */
const PROBEABLE_LAUNCH_AGENTS: readonly TuiAgent[] = ['claude', 'codex', 'cursor']

/** Cursor's probe (`parseCursorModels`) derives `thinkingLevels` from an id-pattern heuristic
 *  (`/gpt-5|codex/`), which happens to cover `gpt-5.3-codex` but not `claude-opus-4-8` -- both
 *  carry a real `effort` option in CURSOR_SESSION_OPTION_CATALOG. Trusting the probe here would
 *  reject a catalog-valid effort on one of Cursor's two effort-capable models depending on which
 *  one was requested. Same shape of gap as Codex's; effort stays catalog-validated. */
const AGENTS_WITH_PROBED_EFFORT: readonly TuiAgent[] = ['claude']

export async function resolveWorkerLaunchPreferences(args: {
  agent: TuiAgent
  model?: string
  effort?: string
  /** True when the worker will not execute on this host (e.g. `--on` targets a remote/SSH
   *  execution host) -- a probe spawned here cannot speak for what that host's CLI accepts (I1). */
  remotePlacement?: boolean
  /** The agent's configured launch command override, if any. The probe always spawns the plain
   *  CLI, so a custom command changes what actually runs without the probe ever seeing it (I1). */
  agentCommandOverride?: string
  /** Test seam only; production always uses the real local discovery executor. */
  discoverAgentModels?: AgentLaunchModelDiscovery
}): Promise<{
  preferences: AgentLaunchPreferences | undefined
  receipt: OrchestrationWorkerLaunchReceipt
}> {
  if (args.effort && !args.model) {
    throw new OrchestrationError('invalid_argument', '--effort requires --model.')
  }
  if (!args.model) {
    return {
      preferences: undefined,
      // Why an explicit 'catalog' label: nothing was requested to override, so effective trivially
      // equals requested -- but the receipt still must not be a bare clone with no source (I1).
      receipt: { ...createWorkerLaunchReceipt({ agent: args.agent }), source: 'catalog' }
    }
  }

  const catalog = getAgentSessionOptionCatalog(args.agent)
  if (!catalog?.supportsWorkerLaunchPreferences || !catalog.modelApply.launchArgs) {
    throw new OrchestrationError(
      'invalid_argument',
      `Agent ${args.agent} does not support launch-time model selection.`
    )
  }

  if (args.effort) {
    const model = findCatalogModel(catalog, args.model)
    const option =
      findCatalogOption(model, 'effort') ??
      (!model
        ? catalog.unknownModelOptions?.find((candidate) => candidate.id === 'effort')
        : undefined)
    if (
      option?.kind.type !== 'select' ||
      !option.kind.choices.some((choice) => choice.value === args.effort)
    ) {
      throw new OrchestrationError(
        'invalid_argument',
        `Agent ${args.agent} model ${args.model} does not support effort ${args.effort}.`
      )
    }
  }

  const requested = {
    model: args.model,
    ...(args.effort ? { effort: args.effort } : {})
  }
  const resolved = resolveAgentSessionOptionLaunch(args.agent, requested, [], false)
  if (
    resolved.appliedValues.model !== args.model ||
    resolved.appliedValues.effort !== args.effort
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      `Agent ${args.agent} cannot apply the requested worker launch preferences.`
    )
  }

  const preferences: AgentLaunchPreferences = requested

  // Why: only claude and codex have a live model probe wired here today (issue #10846,
  // I2) -- see PROBEABLE_LAUNCH_AGENTS for why grok is not among them.
  if (PROBEABLE_LAUNCH_AGENTS.includes(args.agent)) {
    const label = getAgentModelProbeSpec(args.agent)?.label ?? args.agent
    // Why scoped before probing: the probe always spawns the plain agent binary on THIS host
    // (probeAgentModelsOnce), so its answer only speaks for a launch that actually runs that
    // exact command, here. A remote/SSH placement or a configured command override means the
    // worker will not run what was just probed -- reporting 'probe' there would claim
    // verification of a CLI invocation nothing ever asked (I1).
    const unscopedReason = args.remotePlacement
      ? `The worker runs on a remote execution host; the local ${label} CLI probe cannot verify what it will accept.`
      : args.agentCommandOverride
        ? `This agent has a custom launch command the local ${label} CLI probe did not see.`
        : null
    if (unscopedReason) {
      const base = createWorkerLaunchReceipt({ agent: args.agent, ...preferences })
      return {
        preferences,
        receipt: {
          requested: base.requested,
          effective: null,
          source: 'unverified',
          unverifiedReason: unscopedReason
        }
      }
    }
    const verification = await verifyAgentLaunchSelection(
      args.agent,
      args.model,
      args.effort,
      args.discoverAgentModels ?? discoverCommitMessageModelsLocal,
      AGENTS_WITH_PROBED_EFFORT.includes(args.agent)
    )
    if (verification.outcome === 'rejected') {
      throw new OrchestrationError('invalid_argument', verification.reason)
    }
    const base = createWorkerLaunchReceipt({ agent: args.agent, ...preferences })
    return {
      preferences,
      receipt:
        verification.outcome === 'accepted'
          ? {
              ...base,
              // I4: finalizeModelDiscoveryOutput labels a static-catalog fallback (the installed
              // CLI exited 0 but returned no parseable model list) catalogOrigin: 'spec' with
              // success: true -- only 'probe' means the live CLI actually named this model.
              source: verification.catalogOrigin === 'probe' ? 'probe' : 'catalog',
              ...(verification.effortSource ? { effortSource: verification.effortSource } : {})
            }
          : {
              requested: base.requested,
              effective: null,
              source: 'unverified',
              unverifiedReason: verification.reason
            }
    }
  }

  return {
    preferences,
    receipt: {
      ...createWorkerLaunchReceipt({ agent: args.agent, ...preferences }),
      source: 'catalog'
    }
  }
}

export function assertWorkerLaunchPreferencesCreateTerminal(args: {
  terminal?: string
  model?: string
  effort?: string
}): void {
  if (args.terminal && (args.model || args.effort)) {
    throw new OrchestrationError(
      'invalid_argument',
      '--model and --effort cannot be applied when reusing an existing terminal.'
    )
  }
}

export function assertWorkerLaunchPreferencesRuntimeSupported(args: {
  model?: string
  effort?: string
  capabilities?: readonly string[]
  serverName: string
}): void {
  if (
    (args.model || args.effort) &&
    !args.capabilities?.includes(ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY)
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${args.serverName} does not support worker model or effort overrides.`
    )
  }
}

export function resolveFederatedWorkerLaunchReceipt(
  remote: OrchestrationWorkerLaunchReceipt | undefined,
  requested: OrchestrationWorkerLaunchReceipt,
  remoteReady: boolean
): OrchestrationWorkerLaunchReceipt {
  if (remote) {
    return remote
  }
  // Why effective: null, not a clone (I1): the remote server never told us what it actually
  // applied (an older remote, or one that answered before its own receipt arrived). Cloning
  // `requested` into `effective` here would look identical to a verified receipt to anything
  // that reads `effective` without also checking `source` -- 'unverified' means there is no
  // effective selection to report, full stop.
  return remoteReady
    ? {
        requested: requested.requested,
        effective: null,
        source: 'unverified',
        unverifiedReason: 'The worker server did not report which launch options it applied.'
      }
    : requested
}
