/**
 * The official model ids `worker-start --model` accepts, per executing host.
 *
 * The agent CLI on the host that will run the worker is the only authority for which ids exist
 * there, so this reuses the same probe the native chat model picker uses
 * (`runtime.discoverRuntimeCommitMessageModels`), which already routes local / WSL / SSH from the
 * worktree selector, and the same catalog policy that decides what the picker offers — so the set
 * `worker-start` accepts is the set the picker lists.
 *
 * Two things answer `seed`, which claims no membership at all and so refuses nothing.
 *
 * A host that could not be listed: loss of contact is never evidence that a model does not exist
 * there (`docs/reference/ssh-execution-boundary.md`).
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
  /** The host's whole membership. Empty and meaningless unless `source` is `live`. */
  modelIds: readonly string[]
}

export type WorkerLaunchModelDiscoveryRuntime = Pick<
  OrcaRuntimeService,
  'discoverRuntimeCommitMessageModels' | 'resolveRuntimeCommitMessageDiscoveryHostKey'
>

const DISCOVERY_TTL_MS = 3 * 60_000
/** A dispatch may not wait out the probe's own 60s budget; the seed answers past this. */
const DISCOVERY_BUDGET_MS = 10_000

export const SEED_WORKER_LAUNCH_MODEL_AUTHORITY: WorkerLaunchModelAuthority = {
  source: 'seed',
  modelIds: []
}

type CachedModels = { expiresAt: number; models: readonly CommitMessageModelCapability[] }

/** Keyed by executing host, not by caller: one machine's CLI list is one fact. */
const cachedByHost = new Map<string, CachedModels>()
const inFlightByHost = new Map<string, Promise<readonly CommitMessageModelCapability[] | null>>()

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
  return {
    source: 'live',
    modelIds: resolveDiscoveredCatalogModels(args.agent, args.catalog, discovered).map(
      ({ id }) => id
    )
  }
}

async function probeHostModels(
  runtime: WorkerLaunchModelDiscoveryRuntime,
  agent: TuiAgent,
  worktreeSelector: string
): Promise<readonly CommitMessageModelCapability[] | null> {
  try {
    const result = await runtime.discoverRuntimeCommitMessageModels(worktreeSelector, agent)
    // `catalogOrigin: 'spec'` is the probe falling back to Orca's own list, not a CLI answer.
    return result.success && result.catalogOrigin === 'probe' && result.models.length > 0
      ? result.models
      : null
  } catch {
    return null
  }
}

function withDiscoveryBudget(
  pending: Promise<readonly CommitMessageModelCapability[] | null>
): Promise<readonly CommitMessageModelCapability[] | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), DISCOVERY_BUDGET_MS)
    timer.unref?.()
    void pending.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}

function readCachedModels(scope: string): readonly CommitMessageModelCapability[] | null {
  const now = Date.now()
  for (const [key, entry] of cachedByHost) {
    if (entry.expiresAt <= now) {
      cachedByHost.delete(key)
    }
  }
  return cachedByHost.get(scope)?.models ?? null
}

/**
 * `worktreeSelector` names the worktree whose host will run the worker; pass null when no
 * worktree exists yet on that host, which leaves the seed as the only honest answer.
 */
export async function resolveWorkerLaunchModelAuthority(args: {
  catalog: AgentSessionOptionCatalog
  agent: TuiAgent
  runtime: WorkerLaunchModelDiscoveryRuntime | null
  worktreeSelector: string | null
}): Promise<WorkerLaunchModelAuthority> {
  const { catalog, agent, runtime, worktreeSelector } = args
  // Why: for an agent whose probe only EXTENDS the seed, the host's list is known not to be
  // exhaustive, so it can refuse nothing — and there is correspondingly nothing to ask it.
  if (!discoveredModelsReplaceSeed(agent, catalog)) {
    return SEED_WORKER_LAUNCH_MODEL_AUTHORITY
  }
  if (!runtime || !worktreeSelector) {
    return SEED_WORKER_LAUNCH_MODEL_AUTHORITY
  }
  // A selector this host cannot resolve (an unknown worktree, a folder workspace) has no host to
  // ask; the probe would fail the same way, so skip it rather than spend the budget.
  let hostKey: string
  try {
    hostKey = await runtime.resolveRuntimeCommitMessageDiscoveryHostKey(worktreeSelector)
  } catch (error) {
    // An unresolvable selector and a runtime that no longer carries this method both land here,
    // and only the second makes `--model` validation a permanent no-op. A missing method is the
    // TypeError; say so, because nothing else would ever surface it.
    if (error instanceof TypeError) {
      console.error('[worker-launch] no discovery host key; --model cannot be checked:', error)
    }
    return SEED_WORKER_LAUNCH_MODEL_AUTHORITY
  }
  const scope = `${agent} ${hostKey}`
  const cached = readCachedModels(scope)
  if (cached) {
    return liveWorkerLaunchModelAuthority({ catalog, agent, models: cached })
  }
  let pending = inFlightByHost.get(scope)
  if (!pending) {
    // Failures are never cached, so the next dispatch retries rather than inheriting a miss.
    pending = probeHostModels(runtime, agent, worktreeSelector).then((models) => {
      inFlightByHost.delete(scope)
      if (models) {
        cachedByHost.set(scope, { expiresAt: Date.now() + DISCOVERY_TTL_MS, models })
      }
      return models
    })
    inFlightByHost.set(scope, pending)
  }
  // A dispatch that gives up on the budget still leaves the probe running for the next one.
  const models = await withDiscoveryBudget(pending)
  return models
    ? liveWorkerLaunchModelAuthority({ catalog, agent, models })
    : SEED_WORKER_LAUNCH_MODEL_AUTHORITY
}

export function describeWorkerLaunchModelRejection(args: {
  agent: TuiAgent
  model: string
  authority: WorkerLaunchModelAuthority
}): string {
  const ids = [...args.authority.modelIds].sort()
  return `Agent ${args.agent} does not accept model ${args.model}. Accepted ids (listed by the ${args.agent} CLI on the executing host): ${ids.join(', ')}.`
}

export function clearWorkerLaunchModelAuthorityCacheForTests(): void {
  cachedByHost.clear()
  inFlightByHost.clear()
}
