import type { StructuredAgentResolutionOperation } from '../agent-launch/structured-agent-command-resolution'
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
import type { AgentModelCatalogProgress } from './agent-model-catalog-discovery'
import type { AgentModelCatalogStore } from './agent-model-catalog-store'

/** Pin listings to the spawned child's account so later selections cannot receive its results. */
export type AgentModelCatalogSessionAccess = {
  store: AgentModelCatalogStore
  fingerprint: string
  accountHomePath: string
}

/** The owner outlives readers and fences all observations from this listing. */
export type AgentModelCatalogListModels = (
  selectedModels: readonly string[] | undefined,
  owner: StructuredAgentResolutionOperation,
  publish?: AgentModelCatalogProgress
) => Promise<AgentModelCatalogSuccess>

/** Covers the gap between one waiting read and the next, so a following reader keeps its place. */
const AGENT_MODEL_CATALOG_RELEASE_GRACE_MS = 5_000

/** Queued listings need a holder; admitted probes run until completion or retirement. */
export type AgentModelCatalogListingBudget = {
  /** Queue expiry withdraws unadmitted work only. */
  deadline?: number
  /** This caller's interest; a queued listing is withdrawn a grace after no holder is left. */
  signal?: AbortSignal
  /** Service shutdown retires the listing immediately, without the holder release grace. */
  lifetime?: AbortSignal
  admission?: PrioritySemaphore
}

export type InFlightListing = {
  agent: string
  targets: Set<string>
  current: () => boolean
  /** Adds a queued holder until its signal aborts; admitted probes need none. */
  hold: (signal: AbortSignal | undefined) => void
  flush: (model?: string) => void
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
    const fresh = !flight.targets.has(model)
    flight.targets.add(model)
    if (fresh) {
      flight.flush(model)
    }
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
  failed: () => void
  writeSuccess: (
    fingerprint: string,
    agent: string,
    success: AgentModelCatalogSuccess,
    source: AgentModelCatalogSource,
    settled?: boolean,
    accountKnown?: boolean,
    unchanged?: boolean
  ) => AgentModelCatalogEntry | null
}): Promise<AgentModelCatalogEntry | null> {
  const { fingerprint, agent, listModels } = input
  const { signal, lifetime, admission, deadline: budgetDeadline } = input.budget ?? {}
  let deadline = budgetDeadline
  const existing = input.refreshes.get(fingerprint)
  if (existing) {
    existing.hold(signal)
    demandAgentModelEfforts(existing, input.selectedModel, input.maxTargets)
    return existing.promise
  }
  const result = Promise.withResolvers<AgentModelCatalogEntry | null>()
  const stopped = new AbortController()
  let expiry: ReturnType<typeof setTimeout> | undefined
  const holders = new Map<AbortSignal, () => void>()
  // A listing started without a signal is held until it settles.
  let admitted = false
  const queuedAt = Date.now()
  let held = signal === undefined
  const setDeadline = (next: number | undefined): void => {
    deadline = next
    clearTimeout(expiry)
    if (deadline !== undefined) {
      expiry = setTimeout(retire, Math.max(0, deadline - Date.now()))
    }
  }
  let flush: (model?: string) => void = () => {}
  const flight: InFlightListing = {
    agent,
    targets: new Set(input.selectedModel ? [input.selectedModel] : []),
    current: () =>
      !lifetime?.aborted && (admitted || deadline === undefined || Date.now() < deadline),
    hold: (holder) => {
      if (!held && holder && !holder.aborted && !holders.has(holder)) {
        setDeadline(budgetDeadline)
        const abandon = (): void => {
          holders.delete(holder)
          if (!held && holders.size === 0) {
            setDeadline(
              Math.min(
                budgetDeadline ?? Infinity,
                Date.now() + AGENT_MODEL_CATALOG_RELEASE_GRACE_MS
              )
            )
          }
        }
        holders.set(holder, abandon)
        holder.addEventListener('abort', abandon, { once: true })
      }
    },
    flush: (model) => flush(model),
    promise: result.promise,
    finish: result.resolve,
    cleanup: () => {
      clearTimeout(expiry)
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
  setDeadline(budgetDeadline)
  flight.hold(signal)
  lifetime?.addEventListener('abort', retire, { once: true })
  if (signal?.aborted || !flight.current()) {
    retire()
  }
  const span = startSpan('agentModelCatalog.discovery', { attributes: { agent, lister: 'probe' } })
  void Promise.resolve().then(async () => {
    let release: (() => void) | undefined
    let entry: AgentModelCatalogEntry | null = null
    let lastSuccess: AgentModelCatalogSuccess | undefined
    let lastAccountKnown = false
    let published: string | undefined
    let deferred:
      | { read: () => AgentModelCatalogSuccess; known: (model: string) => boolean }
      | undefined
    const publish = (success: AgentModelCatalogSuccess, accountKnown = false, settled = false) => {
      if (!current() || stopped.signal.aborted || success.models.length === 0) {
        return
      }
      const key = JSON.stringify([success, accountKnown])
      if (key === published) {
        if (settled) {
          entry = input.writeSuccess(
            fingerprint,
            agent,
            success,
            'discovery',
            true,
            accountKnown,
            true
          )
        }
        return
      }
      deferred = undefined
      published = key
      lastSuccess = success
      lastAccountKnown = accountKnown
      entry = input.writeSuccess(fingerprint, agent, success, 'discovery', settled, accountKnown)
      input.listingWaiters.notify(fingerprint)
    }
    const progress: AgentModelCatalogProgress = Object.assign(publish, {
      defer: (read: () => AgentModelCatalogSuccess, known: (model: string) => boolean) => {
        if (current() && !stopped.signal.aborted) {
          deferred = { read, known }
        }
      },
      demanded: () => flight.targets
    })
    flush = (model) => {
      if (!current() || stopped.signal.aborted || !deferred || (model && !deferred.known(model))) {
        return
      }
      const observation = deferred
      deferred = undefined
      publish(observation.read(), true)
    }
    try {
      release = await admission?.acquire(0, stopped.signal)
      if (!current()) {
        span.end()
        return
      }
      admitted = true
      span.setAttribute('queuedMs', Date.now() - queuedAt)
      held = true
      setDeadline(undefined)
      const owner: StructuredAgentResolutionOperation = {
        current: () => current() && !stopped.signal.aborted,
        signal: stopped.signal
      }
      let targets = flight.targets.size > 0 ? [...flight.targets] : undefined
      const tried = new Set<string>()
      do {
        for (const target of targets ?? []) {
          tried.add(target)
        }
        const success = await listModels(targets, owner, progress)
        if (!current()) {
          return
        }
        deferred = undefined
        span.setAttribute('models', success.models.length)
        publish(success, lastSuccess ? lastAccountKnown : true, true)
        const attempted = new Set(success.attemptedModels ?? targets ?? [])
        for (const target of attempted) {
          tried.add(target)
          input.targetAttempted(target)
        }
        for (const target of flight.targets) {
          if (attempted.has(target) || !input.targetDue(target)) {
            flight.targets.delete(target)
          }
        }
        targets = [...flight.targets].filter(
          (target) => !tried.has(target) && input.targetDue(target)
        )
      } while (targets.length > 0 && current() && !stopped.signal.aborted)
      if (current()) {
        flight.finish(entry)
      }
      span.end()
    } catch (error) {
      span.fail(error instanceof Error ? error : String(error))
      if (
        current() &&
        !stopped.signal.aborted &&
        !(error instanceof AgentModelCatalogListingStoppedError)
      ) {
        flush()
        if (entry && lastSuccess) {
          publish({ ...lastSuccess, complete: false }, lastAccountKnown, true)
          flight.finish(entry)
          return
        }
        input.failed()
        input.failures.probeFailed(fingerprint, agent, error)
      }
    } finally {
      retire()
      release?.()
    }
  })
  return flight.promise
}
