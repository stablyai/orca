import type { StructuredAgentResolutionOperation } from '../structured-agent-command-resolution'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-record'
import type { PrioritySemaphore } from '../../../shared/priority-semaphore'
import { startSpan } from '../../observability/tracer'
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

/** Pin listings to the spawned child's account so later selections cannot receive its results. */
export type AgentModelCatalogSessionAccess = {
  store: AgentModelCatalogStore
  fingerprint: string
  accountHomePath: string
}

export type InFlightListing = {
  agent: string
  current?: () => boolean
  promise: Promise<AgentModelCatalogEntry | null>
  finish: (entry: AgentModelCatalogEntry | null) => void
  cleanup: () => void
}

/** Only the exact owner may detach a flight and release its waiters. */
export function retireAgentModelCatalogListing(
  refreshes: Map<string, InFlightListing>,
  listingWaiters: AgentModelCatalogListingWaiters,
  fingerprint: string,
  expected: InFlightListing
): void {
  if (refreshes.get(fingerprint) !== expected) {
    return
  }
  refreshes.delete(fingerprint)
  expected.cleanup()
  expected.finish(null)
  listingWaiters.notify(fingerprint)
}

export function refreshAgentModelCatalogListing(input: {
  fingerprint: string
  agent: string
  listModels: () => Promise<AgentModelCatalogSuccess>
  current?: () => boolean
  signal?: AbortSignal
  refreshes: Map<string, InFlightListing>
  failures: AgentModelCatalogFailures
  listingWaiters: AgentModelCatalogListingWaiters
  writeSuccess: (
    fingerprint: string,
    agent: string,
    success: AgentModelCatalogSuccess,
    source: AgentModelCatalogSource
  ) => AgentModelCatalogEntry | null
}): Promise<AgentModelCatalogEntry | null> {
  const { fingerprint, agent, listModels, signal } = input
  const existing = input.refreshes.get(fingerprint)
  if (existing) {
    return existing.promise
  }
  const result = Promise.withResolvers<AgentModelCatalogEntry | null>()
  const flight: InFlightListing = {
    agent,
    current: input.current,
    promise: result.promise,
    finish: result.resolve,
    cleanup: () => signal?.removeEventListener('abort', retire)
  }
  const retire = (): void =>
    retireAgentModelCatalogListing(input.refreshes, input.listingWaiters, fingerprint, flight)
  const current = (): boolean =>
    input.refreshes.get(fingerprint) === flight && !signal?.aborted && flight.current?.() !== false
  input.refreshes.set(fingerprint, flight)
  signal?.addEventListener('abort', retire, { once: true })
  if (signal?.aborted) {
    retire()
  }
  const span = startSpan('agentModelCatalog.discovery', { attributes: { agent, lister: 'probe' } })
  void Promise.resolve().then(async () => {
    try {
      if (!current()) {
        span.end()
        return
      }
      const success = await listModels()
      if (current()) {
        span.setAttribute('models', success.models.length)
        flight.finish(input.writeSuccess(fingerprint, agent, success, 'discovery'))
      }
      span.end()
    } catch (error) {
      span.fail(error instanceof Error ? error : String(error))
      if (current() && !(error instanceof AgentModelCatalogListingStoppedError)) {
        input.failures.probeFailed(fingerprint, agent, error)
      }
    } finally {
      retire()
    }
  })
  return flight.promise
}

export function scopedAgentModelCatalogLister(input: {
  legacy?: boolean
  operation?: StructuredAgentResolutionOperation
  canList: () => boolean
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
    // Share the retry budget and await bounded provider teardown before settling.
    const timer = legacy ? setTimeout(() => deadline.abort(), 30_000) : undefined
    const attemptSignal = AbortSignal.any([signal, deadline.signal])
    try {
      if (!input.canList()) {
        throw new AgentModelCatalogListingStoppedError('catalog scope unavailable')
      }
      if (resolved) {
        return await resolved.run(attemptSignal)
      }
      if (!probe || !probeHome) {
        throw new AgentModelCatalogListingStoppedError('catalog scope unavailable')
      }
      return await probe(probeHome, {
        signal: attemptSignal,
        workspacePath,
        operation: input.operation
      })
    } catch (error) {
      throw signal.aborted ? new AgentModelCatalogListingStoppedError(String(error)) : error
    } finally {
      clearTimeout(timer)
      release()
    }
  }
}
