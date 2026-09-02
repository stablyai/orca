import { uncRouteKey } from '../../providers/working-directory-validation'
import { classifyGitCommand } from '../wsl-direct-git-read-commands'
import { createAbortError } from './abort-error'
import { GitAdmissionWaiterQueue } from './git-admission-waiter-queue'
import {
  ADMISSION_TIER_VALUE,
  AdmissionEventPublisher,
  DEFAULT_ADMISSION_SCHEDULER_CONFIG,
  type AdmissionBudget,
  type AdmissionClass,
  type AdmissionSchedulerConfig,
  type AdmissionSlotKind,
  type AdmissionWaiter,
  type GitAdmissionGrant,
  type GitAdmissionRequest
} from './git-admission-state'

export type {
  GitAdmissionEvent,
  GitAdmissionGrant,
  GitAdmissionRequest
} from './git-admission-state'
export {
  GENERAL_CAP,
  GENERAL_HEADROOM,
  GIT_ADMISSION_AGING_MS,
  MAX_GIT_CHILDREN,
  NETWORK_CAP,
  NETWORK_HEADROOM,
  ROUTE_CAP,
  ROUTE_HEADROOM
} from './git-admission-state'

function commandClass(args: readonly string[]): AdmissionClass {
  return classifyGitCommand(args) === 'network' ? 'network' : 'general'
}

function routeKey(request: GitAdmissionRequest): string | null {
  const distro = request.wslDistro?.trim().toLowerCase()
  return distro ? `wsl:${distro}` : uncRouteKey(request.cwd)
}

export class GitAdmissionScheduler {
  private readonly config: AdmissionSchedulerConfig
  private readonly budgets = new Map<string, AdmissionBudget>()
  private readonly waiters = new GitAdmissionWaiterQueue()
  private nextWaiterId = 0
  private readonly eventPublisher: AdmissionEventPublisher

  constructor(config: Partial<AdmissionSchedulerConfig> = {}) {
    this.config = { ...DEFAULT_ADMISSION_SCHEDULER_CONFIG, ...config }
    this.eventPublisher = new AdmissionEventPublisher(this.config.onAdmissionEvent)
  }

  acquire(request: GitAdmissionRequest): Promise<GitAdmissionGrant> {
    if (request.signal?.aborted) {
      return Promise.reject(createAbortError())
    }
    const enqueuedAt = this.config.now()
    const { admissionClass, route, budgetKeys } = this.resolveBudgets(request)
    return new Promise<GitAdmissionGrant>((resolve, reject) => {
      const waiter: AdmissionWaiter = {
        id: this.nextWaiterId++,
        args: request.args,
        tier: request.tier ?? 'status',
        admissionClass,
        route,
        enqueuedAt,
        budgetKeys,
        signal: request.signal,
        state: 'queued',
        resolve,
        reject,
        onAbort: () => this.abort(waiter)
      }
      this.waiters.enqueue(waiter)
      this.refreshRouteEligibility(admissionClass, route)
      request.signal?.addEventListener('abort', waiter.onAbort, { once: true })
      if (request.signal?.aborted) {
        this.abort(waiter)
        return
      }
      // Adding a blocked waiter cannot make an older waiter runnable. Avoid a
      // queue scan for every arrival while the fixed-size budget is saturated.
      if (this.slotKindFor(waiter)) {
        this.drain(admissionClass)
      }
    })
  }

  snapshot(): {
    queued: number
    queuedWaiters: { id: number; args: readonly string[]; tier: AdmissionWaiter['tier'] }[]
    budgets: Record<string, { baseUsed: number; headroomUsed: number }>
    candidateCount: number
  } {
    const queuedWaiters = this.waiters.snapshot()
    return {
      queued: this.waiters.count,
      queuedWaiters: queuedWaiters.map(({ id, args, tier }) => ({ id, args, tier })),
      candidateCount: this.waiters.candidateCountForTests,
      budgets: Object.fromEntries(
        [...this.budgets].map(([key, budget]) => [
          key,
          { baseUsed: budget.baseUsed, headroomUsed: budget.headroomUsed }
        ])
      )
    }
  }

  private resolveBudgets(request: GitAdmissionRequest): {
    admissionClass: AdmissionClass
    route: string | null
    budgetKeys: readonly string[]
  } {
    const admissionClass = commandClass(request.args)
    const route = routeKey(request)
    const keys: string[] = [admissionClass]
    if (route) {
      keys.push(`route:${admissionClass}:${route}`)
    }
    for (const key of keys) {
      this.ensureBudget(key)
    }
    return { admissionClass, route, budgetKeys: keys }
  }

  private ensureBudget(key: string): AdmissionBudget {
    let budget = this.budgets.get(key)
    if (budget) {
      return budget
    }
    const isRoute = key.startsWith('route:')
    const isNetwork = key === 'network'
    budget = {
      baseCapacity: isRoute
        ? this.config.routeCap
        : isNetwork
          ? this.config.networkCap
          : this.config.generalCap,
      headroomCapacity: isRoute
        ? this.config.routeHeadroom
        : isNetwork
          ? this.config.networkHeadroom
          : this.config.generalHeadroom,
      baseUsed: 0,
      headroomUsed: 0
    }
    this.budgets.set(key, budget)
    return budget
  }

  private effectiveTier(waiter: AdmissionWaiter, now: number): number {
    const promotions = Math.floor((now - waiter.enqueuedAt) / this.config.agingMs)
    return Math.max(0, ADMISSION_TIER_VALUE[waiter.tier] - promotions)
  }

  private fits(waiter: AdmissionWaiter, slotKind: AdmissionSlotKind): boolean {
    return waiter.budgetKeys.every((key) => {
      const budget = this.ensureBudget(key)
      return slotKind === 'base'
        ? budget.baseUsed < budget.baseCapacity
        : budget.headroomUsed < budget.headroomCapacity
    })
  }

  private slotKindFor(waiter: AdmissionWaiter): AdmissionSlotKind | null {
    return this.fits(waiter, 'base')
      ? 'base'
      : waiter.tier === 'interactive' && this.fits(waiter, 'headroom')
        ? 'headroom'
        : null
  }

  private drain(admissionClass: AdmissionClass): void {
    while (true) {
      const now = this.config.now()
      const globalBudget = this.ensureBudget(admissionClass)
      const selected = this.waiters.nextFitting(
        admissionClass,
        (waiter) => this.effectiveTier(waiter, now),
        globalBudget.baseUsed < globalBudget.baseCapacity,
        globalBudget.headroomUsed < globalBudget.headroomCapacity,
        (waiter) => this.abort(waiter)
      )
      if (!selected) {
        return
      }
      this.grant(selected.waiter, selected.slotKind, now)
    }
  }

  private grant(waiter: AdmissionWaiter, slotKind: AdmissionSlotKind, now: number): void {
    waiter.state = 'granted'
    waiter.slotKind = slotKind
    for (const key of waiter.budgetKeys) {
      const budget = this.ensureBudget(key)
      if (slotKind === 'base') {
        budget.baseUsed += 1
      } else {
        budget.headroomUsed += 1
      }
    }
    this.refreshRouteEligibility(waiter.admissionClass, waiter.route)
    this.waiters.dequeue(waiter)
    const queueWaitMs = Math.max(0, now - waiter.enqueuedAt)
    this.publishEvent(waiter, slotKind, 'grant', queueWaitMs)
    queueMicrotask(() => {
      if (waiter.state !== 'granted') {
        return
      }
      waiter.state = 'settled'
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.resolve({
        queueWaitMs,
        release: this.releaseOnce(waiter, slotKind, queueWaitMs)
      })
    })
  }

  private releaseOnce(
    waiter: AdmissionWaiter,
    slotKind: AdmissionSlotKind,
    queueWaitMs: number
  ): () => void {
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      for (const key of waiter.budgetKeys) {
        const budget = this.ensureBudget(key)
        if (slotKind === 'base') {
          budget.baseUsed -= 1
        } else {
          budget.headroomUsed -= 1
        }
      }
      this.refreshRouteEligibility(waiter.admissionClass, waiter.route)
      this.publishEvent(waiter, slotKind, 'release', queueWaitMs)
      this.pruneRouteBudgets(waiter.budgetKeys)
      this.drain(waiter.admissionClass)
    }
  }

  private abort(waiter: AdmissionWaiter): void {
    if (waiter.state === 'settled') {
      return
    }
    if (waiter.state === 'granted' && waiter.slotKind) {
      this.releaseOnce(
        waiter,
        waiter.slotKind,
        Math.max(0, this.config.now() - waiter.enqueuedAt)
      )()
    }
    const wasQueued = waiter.state === 'queued'
    waiter.state = 'settled'
    waiter.signal?.removeEventListener('abort', waiter.onAbort)
    if (wasQueued) {
      this.waiters.dequeue(waiter)
      this.pruneRouteBudgets(waiter.budgetKeys)
    }
    waiter.reject(createAbortError())
  }

  private publishEvent(
    waiter: AdmissionWaiter,
    slotKind: AdmissionSlotKind,
    phase: 'grant' | 'release',
    queueWaitMs: number
  ): void {
    this.eventPublisher.publish({
      phase,
      waiter,
      slotKind,
      queueWaitMs,
      queued: this.waiters.count,
      budgets: this.budgets
    })
  }

  private pruneRouteBudgets(keys: readonly string[]): void {
    for (const key of keys) {
      const budget = this.budgets.get(key)
      if (
        budget &&
        key.startsWith('route:') &&
        budget.baseUsed === 0 &&
        budget.headroomUsed === 0 &&
        !this.waiters.hasBudget(key)
      ) {
        this.budgets.delete(key)
      }
    }
  }

  private refreshRouteEligibility(admissionClass: AdmissionClass, route: string | null): void {
    const budget = route ? this.ensureBudget(`route:${admissionClass}:${route}`) : null
    this.waiters.updateRouteEligibility(
      admissionClass,
      route,
      !budget || budget.baseUsed < budget.baseCapacity,
      !budget || budget.headroomUsed < budget.headroomCapacity
    )
  }
}

let scheduler = new GitAdmissionScheduler()

export function acquireGitAdmission(request: GitAdmissionRequest): Promise<GitAdmissionGrant> {
  if (process.env.ORCA_GIT_ADMISSION_DISABLED === '1') {
    return Promise.resolve({ queueWaitMs: 0, release: () => {} })
  }
  return scheduler.acquire(request)
}

export function _resetGitAdmissionForTests(replacement = new GitAdmissionScheduler()): void {
  scheduler = replacement
}

export function _gitAdmissionSnapshotForTests(): ReturnType<GitAdmissionScheduler['snapshot']> {
  return scheduler.snapshot()
}
