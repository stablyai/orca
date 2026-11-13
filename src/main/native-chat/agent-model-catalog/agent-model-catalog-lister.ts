import type { StructuredAgentResolutionOperation } from '../agent-launch/structured-agent-command-resolution'
import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/agent-session-account-home'
import type { PrioritySemaphore } from '../../../shared/priority-semaphore'
import { AgentModelCatalogProbeError } from './agent-model-catalog-probe-runner'
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

/** Queued listings need a holder; admitted probes run to their own timeout. */
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
  /** Adds a queued holder until its signal aborts; admitted probes need none. */
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
  failed: () => void
  writeSuccess: (
    fingerprint: string,
    agent: string,
    success: AgentModelCatalogSuccess,
    source: AgentModelCatalogSource
  ) => AgentModelCatalogEntry | null
}): Promise<AgentModelCatalogEntry | null> {
  const { fingerprint, agent, listModels } = input
  const { signal, lifetime, admission, timeoutMs, deadline: budgetDeadline } = input.budget ?? {}
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
      expiry = setTimeout(
        () => {
          if (admitted) {
            stopped.abort(
              new AgentModelCatalogProbeError('Model listing work deadline ended', 'timeout')
            )
          } else {
            retire()
          }
        },
        Math.max(0, deadline - Date.now())
      )
    }
  }
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
    try {
      release = await admission?.acquire(0, stopped.signal)
      if (!current()) {
        span.end()
        return
      }
      admitted = true
      span.setAttribute('queuedMs', Date.now() - queuedAt)
      held = true
      // Admission replaces the abandonment deadline with the probe's own execution budget.
      setDeadline(
        timeoutMs === undefined
          ? budgetDeadline
          : Math.min(budgetDeadline ?? Infinity, Date.now() + timeoutMs)
      )
      const owner: StructuredAgentResolutionOperation = {
        current: () => current() && !stopped.signal.aborted,
        signal: stopped.signal,
        deadline
      }
      let targets = input.selectedModel ? [input.selectedModel] : undefined
      const tried = new Set<string>()
      let entry: AgentModelCatalogEntry | null = null
      do {
        for (const target of targets ?? []) {
          tried.add(target)
        }
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
      if (current() && !(error instanceof AgentModelCatalogListingStoppedError)) {
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

export function scopedAgentModelCatalogLister(input: {
  legacy?: boolean
  signal: AbortSignal
  resolved: AgentModelCatalogResolvedProbe | undefined
  probe: AgentModelCatalogProbe | undefined
  probeHome: AgentSessionAccountHome | null
  workspacePath: string | undefined
}): AgentModelCatalogListModels {
  const { resolved, probe, probeHome, workspacePath } = input
  return async (selectedModels, operation) => {
    const signal = operation.signal
      ? AbortSignal.any([input.signal, operation.signal])
      : input.signal
    try {
      // A slot that frees as the budget ends never starts the queued listing.
      if (operation.current?.() === false) {
        throw new AgentModelCatalogListingStoppedError('listing budget ended')
      }
      if (resolved) {
        return await resolved.run(signal, operation, selectedModels)
      }
      if (!probe || !probeHome) {
        throw new AgentModelCatalogListingStoppedError('catalog scope unavailable')
      }
      return await probe(probeHome, {
        signal,
        workspacePath,
        ...(selectedModels ? { selectedModels } : {}),
        operation
      })
    } catch (error) {
      throw input.signal.aborted
        ? new AgentModelCatalogListingStoppedError(String(error))
        : operation.signal?.aborted
          ? operation.signal.reason
          : error
    }
  }
}
