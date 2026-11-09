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

/** Covers the gap between one waiting read and the next, so a following reader keeps its place. */
const AGENT_MODEL_CATALOG_RELEASE_GRACE_MS = 5_000

/** A listing runs while any holder's `signal` is live; its timeout only bounds the probe. */
export type AgentModelCatalogListingBudget = {
  /** Expiry withdraws it from admission, stops its process and drops its late answer. */
  deadline?: number
  /** This caller's interest; a queued listing is withdrawn a grace after no holder is left. */
  signal?: AbortSignal
  /** Service shutdown retires the listing immediately, without the holder release grace. */
  lifetime?: AbortSignal
  admission?: PrioritySemaphore
  /** Execution time after admission. */
  timeoutMs?: number
}

export type InFlightListing = {
  agent: string
  targets: Set<string>
  current: () => boolean
  /** Adds a holder until its signal aborts; no signal adds none. */
  hold: (signal: AbortSignal | undefined) => void
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
  const { signal, lifetime, admission, timeoutMs } = input.budget ?? {}
  let deadline = input.budget?.deadline
  const existing = input.refreshes.get(fingerprint)
  if (existing) {
    existing.hold(signal)
    demandAgentModelEfforts(existing, input.selectedModel, input.maxTargets)
    return existing.promise
  }
  const result = Promise.withResolvers<AgentModelCatalogEntry | null>()
  // Ending the flight (its timeout, the account or CLI retired, or no holder left while queued)
  // stops its process. Once admitted it runs to its timeout: its answer stays valid for the scope.
  const stopped = new AbortController()
  let expiry: ReturnType<typeof setTimeout> | undefined
  const holders = new Map<AbortSignal, () => void>()
  // A listing started without a signal is held until it settles.
  let held = signal === undefined
  let released = -Infinity
  let grace: ReturnType<typeof setTimeout> | undefined
  const flight: InFlightListing = {
    agent,
    targets: new Set(input.selectedModel ? [input.selectedModel] : []),
    current: () =>
      !lifetime?.aborted &&
      (held || holders.size > 0 || Date.now() < released + AGENT_MODEL_CATALOG_RELEASE_GRACE_MS) &&
      (deadline === undefined || Date.now() < deadline),
    hold: (holder) => {
      if (holder && !holder.aborted && !holders.has(holder)) {
        const abandon = (): void => {
          holders.delete(holder)
          if (holders.size === 0) {
            released = Date.now()
            clearTimeout(grace)
            grace = setTimeout(() => {
              if (!flight.current()) {
                retire()
              }
            }, AGENT_MODEL_CATALOG_RELEASE_GRACE_MS)
          }
        }
        holders.set(holder, abandon)
        holder.addEventListener('abort', abandon, { once: true })
      }
    },
    promise: result.promise,
    finish: result.resolve,
    cleanup: () => {
      clearTimeout(expiry)
      clearTimeout(grace)
      lifetime?.removeEventListener('abort', retire)
      for (const [holder, abandon] of holders) {
        holder.removeEventListener('abort', abandon)
      }
      stopped.abort()
    }
  }
  const retire = (): void =>
    retireAgentModelCatalogListing(input.refreshes, input.listingWaiters, fingerprint, flight)
  const current = (): boolean => input.refreshes.get(fingerprint) === flight && flight.current()
  input.refreshes.set(fingerprint, flight)
  flight.hold(signal)
  lifetime?.addEventListener('abort', retire, { once: true })
  const expire = (): void => {
    clearTimeout(expiry)
    if (deadline !== undefined) {
      expiry = setTimeout(retire, Math.max(0, deadline - Date.now()))
    }
  }
  expire()
  if (!flight.current()) {
    retire()
  }
  const span = startSpan('agentModelCatalog.discovery', { attributes: { agent, lister: 'probe' } })
  void Promise.resolve().then(async () => {
    let release: (() => void) | undefined
    try {
      release = await admission?.acquire(0, stopped.signal)
      if (!current()) {
        span.end()
        return
      }
      held = true
      if (timeoutMs !== undefined) {
        deadline = Math.min(deadline ?? Infinity, Date.now() + timeoutMs)
        expire()
      }
      const owner: StructuredAgentResolutionOperation = {
        current,
        signal: stopped.signal,
        deadline
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
      release?.()
    }
  })
  return flight.promise
}

export function scopedAgentModelCatalogLister(input: {
  legacy?: boolean
  signal: AbortSignal
  resolved: AgentModelCatalogResolvedProbe | undefined
  probe: AgentModelCatalogProbe | undefined
  probeHome: AgentSessionAccountHome | null
  workspacePath: string | undefined
}): AgentModelCatalogListModels {
  const { legacy, resolved, probe, probeHome, workspacePath } = input
  return async (selectedModels, operation) => {
    const signal = operation.signal
      ? AbortSignal.any([input.signal, operation.signal])
      : input.signal
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
    }
  }
}
