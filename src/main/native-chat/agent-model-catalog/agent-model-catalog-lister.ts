import type { AgentSessionAccountHome } from '../../../shared/agent-session-record'
import type { PrioritySemaphore } from '../../../shared/priority-semaphore'
import { startSpan } from '../../observability/tracer'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import {
  AgentModelCatalogListingStoppedError,
  type AgentModelCatalogFailures
} from './agent-model-catalog-failures'
import type { AgentModelCatalogListingWaiters } from './agent-model-catalog-listing-waiters'
import type {
  AgentModelCatalogEntry,
  AgentModelCatalogSource,
  AgentModelCatalogSuccess
} from './agent-model-catalog-entry'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogResolvedProbe
} from './agent-model-catalog-discovery'
import type { AgentModelCatalogStore } from './agent-model-catalog-store'

/** Who lists, by identity: a live session's per-spawn handle, or the session-less probe. */
export type AgentModelCatalogLister = AgentModelCatalogSessionAccess | AgentModelCatalogProbe

/** A live session's handle into the store, pinned at spawn to the account home
 *  THAT child launched under — an account switched afterwards must never
 *  receive or poison this session's listing. */
export type AgentModelCatalogSessionAccess = {
  store: AgentModelCatalogStore
  fingerprint: string
  accountHomePath: string
}

export type InFlightListings = Map<AgentModelCatalogLister, Promise<AgentModelCatalogEntry | null>>

type CatalogSuccessWriter = (
  fingerprint: string,
  agent: string,
  success: AgentModelCatalogSuccess,
  source: AgentModelCatalogSource,
  order: number
) => AgentModelCatalogEntry | null

export function refreshAgentModelCatalogListing(input: {
  fingerprint: string
  agent: string
  lister: AgentModelCatalogLister
  listModels: () => Promise<AgentModelCatalogSuccess>
  refreshes: Map<string, InFlightListings>
  entries: ReadonlyMap<string, AgentModelCatalogEntry>
  latestWrittenOrder: Map<string, number>
  failures: AgentModelCatalogFailures
  listingWaiters: AgentModelCatalogListingWaiters
  nextListingOrder: () => number
  entryFromSuccess: (
    fingerprint: string,
    agent: string,
    success: AgentModelCatalogSuccess,
    source: AgentModelCatalogSource
  ) => AgentModelCatalogEntry | null
  writeSuccess: CatalogSuccessWriter
  recordFailure: (fingerprint: string, detail: string, agent?: string) => void
}): Promise<AgentModelCatalogEntry | null> {
  const { fingerprint, agent, lister, listModels } = input
  const listers: InFlightListings = input.refreshes.get(fingerprint) ?? new Map()
  const inFlight = independentAgentModelCatalog(agent)
    ? listers.values().next().value
    : listers.get(lister)
  if (inFlight) {
    return inFlight
  }
  const settle = (): void => {
    listers.delete(lister)
    if (listers.size === 0 && input.refreshes.get(fingerprint) === listers) {
      input.refreshes.delete(fingerprint)
      input.latestWrittenOrder.delete(fingerprint)
    }
    input.listingWaiters.notify(fingerprint)
  }
  const order = input.nextListingOrder()
  // Agent, outcome and duration only: a slow listing shows in the trace log without its content.
  const span = startSpan('agentModelCatalog.discovery', {
    attributes: { agent, lister: typeof lister === 'function' ? 'probe' : 'session' }
  })
  const run = listModels().then(
    (success) => {
      span.setAttribute('models', success.models.length)
      span.end()
      // An older lister still receives its own result, but cannot replace a newer discovery.
      const superseded =
        (input.latestWrittenOrder.get(fingerprint) ?? 0) > order && input.entries.has(fingerprint)
      if (superseded && success.origin === 'probe') {
        input.failures.listed(fingerprint, agent, success.origin, success.unavailable)
      }
      const entry = superseded
        ? input.entryFromSuccess(fingerprint, agent, success, 'discovery')
        : input.writeSuccess(fingerprint, agent, success, 'discovery', order)
      settle()
      return entry
    },
    (error: unknown) => {
      span.fail(error instanceof Error ? error : String(error))
      // Probes are functions; a live session lists through its access object.
      if (typeof lister === 'function') {
        if (!(error instanceof AgentModelCatalogListingStoppedError)) {
          input.failures.probeFailed(fingerprint, agent, error)
        }
      } else {
        input.recordFailure(
          fingerprint,
          error instanceof Error ? error.message : String(error),
          agent
        )
      }
      settle()
      return null
    }
  )
  listers.set(lister, run)
  input.refreshes.set(fingerprint, listers)
  return run
}

export function scopedAgentModelCatalogLister(input: {
  legacy?: boolean
  admission: PrioritySemaphore
  signal: AbortSignal
  resolved: AgentModelCatalogResolvedProbe | undefined
  probe: AgentModelCatalogProbe | undefined
  probeHome: AgentSessionAccountHome | null
  workspacePath: string | undefined
}): () => Promise<AgentModelCatalogSuccess> {
  const { legacy, admission, signal, resolved, probe, probeHome, workspacePath } = input
  return async () => {
    const release = legacy ? () => {} : await admission.acquire(0, signal)
    const deadline = new AbortController()
    // Retries share this body budget; bounded provider teardown is awaited before settlement.
    const timer = legacy ? setTimeout(() => deadline.abort(), 30_000) : undefined
    const attemptSignal = AbortSignal.any([signal, deadline.signal])
    try {
      if (resolved) {
        return await resolved.run(attemptSignal)
      }
      if (!probe || !probeHome) {
        throw new AgentModelCatalogListingStoppedError('catalog scope unavailable')
      }
      return await probe(probeHome, { signal: attemptSignal, workspacePath })
    } catch (error) {
      throw signal.aborted ? new AgentModelCatalogListingStoppedError(String(error)) : error
    } finally {
      clearTimeout(timer)
      release()
    }
  }
}

export function agentModelCatalogProbeLister(signal: AbortSignal) {
  return (probe: AgentModelCatalogProbe, home: AgentSessionAccountHome, workspacePath?: string) =>
    (): Promise<AgentModelCatalogSuccess> =>
      probe(home, { signal, workspacePath }).catch((error: unknown) => {
        throw signal.aborted ? new AgentModelCatalogListingStoppedError(String(error)) : error
      })
}
