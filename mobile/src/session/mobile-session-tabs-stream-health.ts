import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcSuccess } from '../transport/types'

export type SessionTabsApplyOutcome<Tab> =
  | { accepted: false }
  | { accepted: true; effectiveTabs: readonly Tab[]; applicationRevision?: number }

export type SessionTabsStreamSource = 'list' | 'stream'

type StreamHealth = 'probing' | 'live' | 'degraded'

type RequestOwner = {
  generation: number
  barrier: number
  requirement: number
  applicationRevision: number
}

type RequestCohort = {
  promise: Promise<void>
  resolve: () => void
}

type ControllerOptions<Result, Tab> = {
  client: RpcClient
  scope: string
  apply: (result: Result) => SessionTabsApplyOutcome<Tab>
  consumeAccepted: (
    result: Result,
    effectiveTabs: readonly Tab[],
    source: SessionTabsStreamSource
  ) => void
  hasRecoveryNeed: () => boolean
  getApplicationRevision?: () => number
  onFetchStarted?: () => void
  onFetchSucceeded?: (result: Result) => void
  onFetchFailed?: (failure: RpcFailure) => void
  onFetchErrored?: (error: unknown) => void
}

type StreamSubscription = {
  listener: (payload: unknown) => void
  cancel: () => void
}

type GenerationClient = RpcClient & { getGeneration?: () => number }

export class MobileSessionTabsStreamHealth<Result, Tab> {
  private readonly inFlight = new Map<string, RequestCohort>()
  private generation: number
  private barrier = 0
  private subscriptionEpoch = 0
  private requirementRevision = 0
  private satisfiedRevision = 0
  private applicationRevision = 0
  private health: StreamHealth = 'probing'
  private snapshotSeen = false
  private reconciliationActive = false
  private disposed = false

  constructor(private readonly options: ControllerOptions<Result, Tab>) {
    this.generation = this.readGeneration()
    this.applicationRevision = this.readApplicationRevision()
  }

  requestReconciliation(): Promise<void> {
    this.syncGeneration()
    this.requirementRevision += 1
    return this.startCurrentRequest()
  }

  ensureReconciliation(): Promise<void> {
    this.syncGeneration()
    if (this.requirementRevision <= this.satisfiedRevision) {
      this.requirementRevision += 1
    }
    return this.startCurrentRequest()
  }

  requestPendingRecovery(): Promise<void> {
    if (!this.options.hasRecoveryNeed()) {
      return Promise.resolve()
    }
    return this.requestReconciliation()
  }

  poll(): Promise<void> | null {
    this.syncGeneration()
    if (
      !this.reconciliationActive ||
      (this.health === 'live' &&
        !this.options.hasRecoveryNeed() &&
        this.requirementRevision <= this.satisfiedRevision)
    ) {
      return null
    }
    return this.ensureReconciliation()
  }

  setReconciliationActive(active: boolean): void {
    this.reconciliationActive = active
  }

  beginSubscription(): StreamSubscription {
    this.syncGeneration()
    const epoch = ++this.subscriptionEpoch
    this.invalidateStream('probing')
    return {
      listener: (payload) => {
        if (this.disposed || epoch !== this.subscriptionEpoch) {
          return
        }
        this.handleStreamPayload(payload)
      },
      cancel: () => {
        if (epoch === this.subscriptionEpoch) {
          this.subscriptionEpoch += 1
          this.invalidateStream('degraded')
        }
      }
    }
  }

  isCertified(): boolean {
    this.syncGeneration()
    return this.health === 'live'
  }

  dispose(): void {
    this.disposed = true
    this.subscriptionEpoch += 1
  }

  private handleStreamPayload(payload: unknown): void {
    this.syncGeneration()
    if (!payload || typeof payload !== 'object') {
      return
    }
    const event = payload as Result & { type?: string }
    if (event.type === 'snapshot') {
      this.invalidateStream('probing')
      this.snapshotSeen = true
      this.applyCurrent(event, 'stream')
      this.startCurrentRequest()
      return
    }
    if (event.type === 'updated') {
      const capturedRequirement = this.requirementRevision
      const ownerGeneration = this.generation
      const outcome = this.applyCurrent(event, 'stream')
      if (!outcome.accepted || !this.isCurrentGeneration(ownerGeneration)) {
        return
      }
      this.health = 'live'
      this.satisfiedRevision = Math.max(this.satisfiedRevision, capturedRequirement)
      this.startTrailingRequest()
      return
    }
    if (event.type === 'error' || event.type === 'end') {
      this.invalidateStream('degraded')
      this.startCurrentRequest()
    }
  }

  private applyCurrent(
    result: Result,
    source: SessionTabsStreamSource
  ): SessionTabsApplyOutcome<Tab> {
    const generation = this.generation
    const outcome = this.options.apply(result)
    if (!outcome.accepted || !this.isCurrentGeneration(generation)) {
      return { accepted: false }
    }
    this.applicationRevision =
      outcome.applicationRevision === undefined
        ? this.applicationRevision + 1
        : Math.max(this.applicationRevision, outcome.applicationRevision)
    this.options.consumeAccepted(result, outcome.effectiveTabs, source)
    return outcome
  }

  private invalidateStream(health: Exclude<StreamHealth, 'live'>): void {
    this.barrier += 1
    this.health = health
    this.snapshotSeen = false
    this.requirementRevision += 1
  }

  private startCurrentRequest(): Promise<void> {
    if (this.disposed || !this.reconciliationActive) {
      return Promise.resolve()
    }
    const key = `${this.generation}:${this.barrier}`
    const shared = this.inFlight.get(key)
    if (shared) {
      return shared.promise
    }
    let resolveRequest!: () => void
    const promise = new Promise<void>((resolve) => {
      resolveRequest = resolve
    })
    const cohort = { promise, resolve: resolveRequest }
    this.inFlight.set(key, cohort)
    this.runCohortRequest(key, cohort)
    return promise
  }

  private runCohortRequest(key: string, cohort: RequestCohort): void {
    const owner: RequestOwner = {
      generation: this.generation,
      barrier: this.barrier,
      requirement: this.requirementRevision,
      applicationRevision: this.readApplicationRevision()
    }
    const finish = (canDrain: boolean): void => {
      if (
        canDrain &&
        this.inFlight.get(key) === cohort &&
        key === `${this.generation}:${this.barrier}` &&
        this.reconciliationActive &&
        this.requirementRevision > this.satisfiedRevision
      ) {
        this.runCohortRequest(key, cohort)
        return
      }
      if (this.inFlight.get(key) === cohort) {
        this.inFlight.delete(key)
      }
      cohort.resolve()
    }
    void this.runRequest(owner).then(finish, () => finish(false))
  }

  private async runRequest(owner: RequestOwner): Promise<boolean> {
    try {
      this.options.onFetchStarted?.()
      const response = await this.options.client.sendRequest('session.tabs.list', {
        worktree: this.options.scope
      })
      if (!this.isCurrentGeneration(owner.generation)) {
        return false
      }
      if (!response.ok) {
        if (owner.barrier === this.barrier) {
          this.options.onFetchFailed?.(response as RpcFailure)
        }
        return false
      }
      const result = (response as RpcSuccess).result as Result
      if (owner.barrier !== this.barrier) {
        return false
      }
      if (owner.applicationRevision !== this.readApplicationRevision()) {
        return false
      }
      this.options.onFetchSucceeded?.(result)
      const outcome = this.applyCurrent(result, 'list')
      if (!outcome.accepted || !this.isCurrentGeneration(owner.generation)) {
        return false
      }
      this.satisfiedRevision = Math.max(this.satisfiedRevision, owner.requirement)
      if (this.snapshotSeen) {
        this.health = 'live'
      }
      return true
    } catch (error) {
      if (this.isCurrentGeneration(owner.generation) && owner.barrier === this.barrier) {
        this.options.onFetchErrored?.(error)
      }
      return false
    }
  }

  private startTrailingRequest(): void {
    if (
      !this.disposed &&
      this.reconciliationActive &&
      this.requirementRevision > this.satisfiedRevision &&
      !this.inFlight.has(`${this.generation}:${this.barrier}`)
    ) {
      void this.startCurrentRequest()
    }
  }

  private syncGeneration(): void {
    if (this.disposed) {
      return
    }
    const generation = this.readGeneration()
    if (generation === this.generation) {
      return
    }
    this.generation = generation
    this.invalidateStream('probing')
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.disposed && generation === this.generation && generation === this.readGeneration()
  }

  private readGeneration(): number {
    return (this.options.client as GenerationClient).getGeneration?.() ?? 0
  }

  private readApplicationRevision(): number {
    return Math.max(this.applicationRevision, this.options.getApplicationRevision?.() ?? 0)
  }
}
