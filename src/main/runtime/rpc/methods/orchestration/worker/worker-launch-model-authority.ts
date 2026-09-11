/**
 * The official model ids `worker-start --model` accepts, per executing host.
 *
 * The agent CLI on the host that will run the worker is the only authority for which ids exist
 * there, so this reuses the same probe the native chat model picker uses
 * (`runtime.discoverRuntimeCommitMessageModels`), which already routes local / WSL / SSH from the
 * worktree selector. Dynamic membership is combined with stable CLI aliases: a picker need not
 * display an alias such as `opus`, but the launch flag still accepts it.
 *
 * Several conditions answer `seed`, which claims no membership at all and so refuses nothing.
 *
 * A host that could not be listed: loss of contact is never evidence that a model does not exist
 * there (`docs/reference/ssh-execution-boundary.md`).
 *
 * A launch whose terminal-only arguments or environment are absent from the probe: that answer is
 * not evidence about the CLI invocation that will actually run.
 *
 * And an agent whose probe only EXTENDS the seed rather than replacing it — the Codex catalog is
 * explicit that its seed is short and that unknown ids must pass through, so a list that merges
 * into it cannot be read as complete. Only an agent whose discovery replaces the seed gets a
 * `live` answer, and only a `live` answer may reject.
 */

import type { CommitMessageModelCapability } from '../../../../../../shared/commit-message-agent-spec'
import {
  discoveredModelsReplaceSeed,
  resolveDiscoveredCatalogModels,
  type AgentSessionOptionCatalog,
  type CatalogModel
} from '../../../../../../shared/agent-session-option-catalog'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

export type WorkerLaunchModelSource = 'live' | 'seed'

export type WorkerLaunchModelAuthority = {
  source: WorkerLaunchModelSource
  /** The host's listed ids plus known CLI aliases. Empty unless `source` is `live`. */
  modelIds: readonly string[]
}

export type WorkerLaunchModelDiscoveryRuntime = Pick<
  OrcaRuntimeService,
  'discoverRuntimeCommitMessageModels' | 'resolveRuntimeCommitMessageDiscoveryHostKey'
>
export type WorkerLaunchModelDiscoveryTarget = string | { repoSelector: string }

const DISCOVERY_TTL_MS = 3 * 60_000
/** A dispatch may not wait out the probe's own 60s budget; the seed answers past this. */
const DISCOVERY_BUDGET_MS = 10_000
const DISCOVERY_BUDGET_EXPIRED = Symbol('worker-launch-model-discovery-budget-expired')

export const SEED_WORKER_LAUNCH_MODEL_AUTHORITY: WorkerLaunchModelAuthority = {
  source: 'seed',
  modelIds: []
}

type CachedModels = { expiresAt: number; models: readonly CommitMessageModelCapability[] }

/** Callers that share an agent, execution host, and resolved command share one CLI fact. */
const cachedByScope = new Map<string, CachedModels>()
const inFlightByScope = new Map<string, Promise<readonly CommitMessageModelCapability[] | null>>()

function discoveredCatalogModel(model: CommitMessageModelCapability): CatalogModel {
  return {
    id: model.id,
    label: model.label,
    ...(model.isDefault ? { isDefault: true as const } : {}),
    // Only membership is read here; effort stays the catalog's, exactly as the picker's merge does.
    options: []
  }
}

function liveWorkerLaunchModelAuthority(args: {
  catalog: AgentSessionOptionCatalog
  agent: TuiAgent
  models: readonly CommitMessageModelCapability[]
}): WorkerLaunchModelAuthority {
  const discovered = args.models.map(discoveredCatalogModel)
  const listedIds = resolveDiscoveredCatalogModels(args.agent, args.catalog, discovered).map(
    ({ id }) => id
  )
  const listedAliases = args.catalog.models
    .filter(
      (model) =>
        model.isCliAlias && listedIds.some((id) => id === model.id || id.startsWith(`${model.id}[`))
    )
    .map(({ id }) => id)
  return {
    source: 'live',
    modelIds: [
      ...new Set([
        ...listedIds,
        ...args.models.flatMap(({ resolvedModel }) => (resolvedModel ? [resolvedModel] : [])),
        ...listedAliases,
        ...(args.catalog.launchModelAliases ?? [])
      ])
    ]
  }
}

async function probeHostModels(
  runtime: WorkerLaunchModelDiscoveryRuntime,
  agent: TuiAgent,
  target: WorkerLaunchModelDiscoveryTarget,
  agentCommandOverride: string
): Promise<readonly CommitMessageModelCapability[] | null> {
  try {
    const result = await runtime.discoverRuntimeCommitMessageModels(target, agent, {
      agentCmdOverrides: { [agent]: agentCommandOverride }
    })
    // `catalogOrigin: 'spec'` is the probe falling back to Orca's own list, not a CLI answer.
    return result.success && result.catalogOrigin === 'probe' && result.models.length > 0
      ? result.models
      : null
  } catch {
    return null
  }
}

function withDiscoveryDeadline<T>(
  pending: Promise<T>,
  deadlineAt: number
): Promise<T | typeof DISCOVERY_BUDGET_EXPIRED> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => resolve(DISCOVERY_BUDGET_EXPIRED),
      Math.max(0, deadlineAt - Date.now())
    )
    timer.unref?.()
    void pending.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function readCachedModels(scope: string): readonly CommitMessageModelCapability[] | null {
  const now = Date.now()
  for (const [key, entry] of cachedByScope) {
    if (entry.expiresAt <= now) {
      cachedByScope.delete(key)
    }
  }
  return cachedByScope.get(scope)?.models ?? null
}

/**
 * `worktreeSelector` names the existing workspace or destination repo whose host will run the
 * worker. The historical name is retained because workspace callers pass string selectors.
 */
export async function resolveWorkerLaunchModelAuthority(args: {
  catalog: AgentSessionOptionCatalog
  agent: TuiAgent
  agentCommandOverride?: string
  runtime: WorkerLaunchModelDiscoveryRuntime | null
  worktreeSelector: WorkerLaunchModelDiscoveryTarget | null
}): Promise<WorkerLaunchModelAuthority> {
  const { catalog, agent, runtime, worktreeSelector: target } = args
  const agentCommandOverride = args.agentCommandOverride?.trim() ?? ''
  // Why: for an agent whose probe only EXTENDS the seed, the host's list is known not to be
  // exhaustive, so it can refuse nothing — and there is correspondingly nothing to ask it.
  if (!discoveredModelsReplaceSeed(agent, catalog)) {
    return SEED_WORKER_LAUNCH_MODEL_AUTHORITY
  }
  if (!runtime || !target) {
    return SEED_WORKER_LAUNCH_MODEL_AUTHORITY
  }
  const deadlineAt = Date.now() + DISCOVERY_BUDGET_MS
  // A selector this host cannot resolve has no host to ask; the probe would fail the same way, so
  // skip it rather than spend the budget.
  let hostKey: string
  try {
    const resolvedHostKey = await withDiscoveryDeadline(
      runtime.resolveRuntimeCommitMessageDiscoveryHostKey(target),
      deadlineAt
    )
    if (resolvedHostKey === DISCOVERY_BUDGET_EXPIRED) {
      return SEED_WORKER_LAUNCH_MODEL_AUTHORITY
    }
    hostKey = resolvedHostKey
  } catch (error) {
    // An unresolvable selector and a runtime that no longer carries this method both land here,
    // and only the second makes `--model` validation a permanent no-op. A missing method is the
    // TypeError; say so, because nothing else would ever surface it.
    if (error instanceof TypeError) {
      console.error('[worker-launch] no discovery host key; --model cannot be checked:', error)
    }
    return SEED_WORKER_LAUNCH_MODEL_AUTHORITY
  }
  const scope = JSON.stringify([agent, hostKey, agentCommandOverride])
  const cached = readCachedModels(scope)
  if (cached) {
    return liveWorkerLaunchModelAuthority({ catalog, agent, models: cached })
  }
  let pending = inFlightByScope.get(scope)
  if (!pending) {
    // Failures are never cached, so the next dispatch retries rather than inheriting a miss.
    pending = probeHostModels(runtime, agent, target, agentCommandOverride).then((models) => {
      inFlightByScope.delete(scope)
      if (models) {
        cachedByScope.set(scope, { expiresAt: Date.now() + DISCOVERY_TTL_MS, models })
      }
      return models
    })
    inFlightByScope.set(scope, pending)
  }
  // A dispatch that gives up on the budget still leaves the probe running for the next one.
  const models = await withDiscoveryDeadline(pending, deadlineAt)
  return models && models !== DISCOVERY_BUDGET_EXPIRED
    ? liveWorkerLaunchModelAuthority({ catalog, agent, models })
    : SEED_WORKER_LAUNCH_MODEL_AUTHORITY
}

export function describeWorkerLaunchModelRejection(args: {
  agent: TuiAgent
  model: string
  authority: WorkerLaunchModelAuthority
}): string {
  const ids = [...args.authority.modelIds].sort()
  return `Agent ${args.agent} does not accept model ${args.model}. Accepted ids for the ${args.agent} CLI on the executing host: ${ids.join(', ')}.`
}

export function clearWorkerLaunchModelAuthorityCacheForTests(): void {
  cachedByScope.clear()
  inFlightByScope.clear()
}
