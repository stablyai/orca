import type { StructuredAgentResolutionOperation } from '../structured-agent-command-resolution'
import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/agent-session-account-home'
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

/** `owner` is the listing's own operation: its fixed budget, never a reader's. */
export type AgentModelCatalogListModels = (
  selectedModels: readonly string[] | undefined,
  owner: StructuredAgentResolutionOperation
) => Promise<AgentModelCatalogSuccess>

/** The refresh that starts a listing gives it its budget; joining never extends or shortens it. */
export type AgentModelCatalogListingBudget = {
  /** Expiry withdraws it from admission, stops its process and drops its late answer. */
  deadline?: number
  signal?: AbortSignal
}

export type InFlightListing = {
  agent: string
  targets: Set<string>
  current: () => boolean
  promise: Promise<AgentModelCatalogEntry | null>
  finish: (entry: AgentModelCatalogEntry | null) => void
  cleanup: () => void
}

export function demandAgentModelEfforts(
  flight: InFlightListing | undefined,
  model: string | undefined,
  cap: number
): void {
  if (model && flight && flight.targets.size < cap) {
    flight.targets.add(model)
  }
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
  listModels: AgentModelCatalogListModels
  selectedModel?: string
  maxTargets: number
  targetDue: (model: string) => boolean
  targetAttempted: (model: string) => void
  budget?: AgentModelCatalogListingBudget
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
  const { fingerprint, agent, listModels } = input
  const { deadline, signal } = input.budget ?? {}
  const existing = input.refreshes.get(fingerprint)
  if (existing) {
    demandAgentModelEfforts(existing, input.selectedModel, input.maxTargets)
    return existing.promise
  }
  const result = Promise.withResolvers<AgentModelCatalogEntry | null>()
  // Ending the flight (its budget, the account or CLI retired, shutdown) stops its process too.
  const stopped = new AbortController()
  const expiry =
    deadline === undefined
      ? undefined
      : setTimeout(() => retire(), Math.max(0, deadline - Date.now()))
  const flight: InFlightListing = {
    agent,
    targets: new Set(input.selectedModel ? [input.selectedModel] : []),
    current: () => !signal?.aborted && (deadline === undefined || Date.now() < deadline),
    promise: result.promise,
    finish: result.resolve,
    cleanup: () => {
      clearTimeout(expiry)
      signal?.removeEventListener('abort', retire)
      stopped.abort()
    }
  }
  const retire = (): void =>
    retireAgentModelCatalogListing(input.refreshes, input.listingWaiters, fingerprint, flight)
  const current = (): boolean => input.refreshes.get(fingerprint) === flight && flight.current()
  const owner: StructuredAgentResolutionOperation = { current, signal: stopped.signal, deadline }
  input.refreshes.set(fingerprint, flight)
  signal?.addEventListener('abort', retire, { once: true })
  if (!flight.current()) {
    retire()
  }
  const span = startSpan('agentModelCatalog.discovery', { attributes: { agent, lister: 'probe' } })
  void Promise.resolve().then(async () => {
    try {
      if (!current()) {
        span.end()
        return
      }
      let targets = input.selectedModel ? [input.selectedModel] : undefined
      let entry: AgentModelCatalogEntry | null = null
      do {
        const success = await listModels(targets, owner)
        if (!current()) {
          return
        }
        span.setAttribute('models', success.models.length)
        entry = input.writeSuccess(fingerprint, agent, success, 'discovery')
        const attempted = new Set(targets ? (success.attemptedModels ?? targets) : [])
        for (const target of targets ?? []) {
          if (attempted.has(target)) {
            input.targetAttempted(target)
          }
          if (attempted.has(target) || !input.targetDue(target)) {
            flight.targets.delete(target)
          }
        }
        targets = [...flight.targets].filter(input.targetDue)
      } while (targets.length > 0 && current())
      if (current()) {
        flight.finish(entry)
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
  admission: PrioritySemaphore
  signal: AbortSignal
  resolved: AgentModelCatalogResolvedProbe | undefined
  probe: AgentModelCatalogProbe | undefined
  probeHome: AgentSessionAccountHome | null
  workspacePath: string | undefined
}): AgentModelCatalogListModels {
  const { legacy, admission, resolved, probe, probeHome, workspacePath } = input
  return async (selectedModels, operation) => {
    const signal = operation.signal
      ? AbortSignal.any([input.signal, operation.signal])
      : input.signal
    // Waiting for a slot spends the listing's own budget; expiry withdraws it from the queue.
    const release = legacy ? () => {} : await admission.acquire(0, signal)
    const deadline = new AbortController()
    // Share the retry budget and await bounded provider teardown before settling.
    const timer = legacy ? setTimeout(() => deadline.abort(), 30_000) : undefined
    const attemptSignal = AbortSignal.any([signal, deadline.signal])
    try {
      // A slot that frees as the budget ends never starts the queued listing.
      if (operation.current?.() === false) {
        throw new AgentModelCatalogListingStoppedError('listing budget ended')
      }
      if (resolved) {
        return await resolved.run(attemptSignal, operation)
      }
      if (!probe || !probeHome) {
        throw new AgentModelCatalogListingStoppedError('catalog scope unavailable')
      }
      return await probe(probeHome, {
        signal: attemptSignal,
        workspacePath,
        ...(selectedModels ? { selectedModels } : {}),
        operation
      })
    } catch (error) {
      throw signal.aborted ? new AgentModelCatalogListingStoppedError(String(error)) : error
    } finally {
      clearTimeout(timer)
      // The slot is held until the provider's teardown finishes.
      release()
    }
  }
}
