import { FollowUpTargetIndex } from './target-index'
import { evaluateFollowUpObservation } from './observation'
import { createFollowUpProjectionState, publishFollowUpProjection } from './projection'
import { FollowUpActivityRouter, type FollowUpActivityAuthority } from './activity-journal'
import { reconcileFollowUpActions } from './action-lifecycle'
import type {
  FollowUpObservation,
  FollowUpView,
  FollowUpTarget
} from '../../shared/pr-follow-ups/contracts'
import type { FollowUpEngineDependencies } from './engine-contract'
export type { FollowUpEngineDependencies, FollowUpReceipt } from './engine-contract'
import { eligibleFollowUpTargets, followUpView } from './follow-up-state'

export class FollowUpEngine {
  private tail: Promise<void> = Promise.resolve()
  private unsubscribe?: () => void
  private disposed = false
  private swept = false
  private readonly inventory: FollowUpTargetIndex
  private readonly activityRouter: FollowUpActivityRouter
  private readonly projection = createFollowUpProjectionState()
  activePrKeys(): string[] {
    return this.activityRouter.activeKeys()
  }

  prKeysForAuthorities(authorities: readonly FollowUpActivityAuthority[]): string[] {
    return this.activityRouter.keys(authorities)
  }

  get waitingForWindow(): boolean {
    return this.projection.windowHolds.size > 0
  }

  private readonly deps: FollowUpEngineDependencies
  constructor(host: FollowUpEngineDependencies) {
    this.activityRouter = new FollowUpActivityRouter(host.store)
    host.store.actionCommitted = (action) => this.activityRouter.committed(action)
    this.inventory = new FollowUpTargetIndex(host, this.projection)
    this.deps = {
      ...host,
      targets: (key) =>
        key ? (this.inventory.byPr.get(key) ?? []) : [...this.inventory.byWorkspace.values()]
    }
    this.refreshInventory()
  }

  refreshInventory(): Set<string> {
    return this.inventory.refreshInventory()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  start(): Promise<void> {
    this.unsubscribe = this.deps.source.subscribePRObservations((observation) => {
      void this.observe(observation).catch((error: unknown) =>
        console.error('[pr-follow-ups] observation failed', error)
      )
    })
    return this.enqueue(() => this.reconcileNow())
  }

  observe(observation: FollowUpObservation): Promise<void> {
    if (
      !this.inventory.byPr.get(observation.prKey)?.length &&
      !this.projection.projections.has(observation.prKey)
    ) {
      return Promise.resolve()
    }
    const key = JSON.stringify(observation)
    if (this.projection.observations.get(observation.prKey) === key) {
      return Promise.resolve()
    }
    this.projection.observations.set(observation.prKey, key)
    return this.enqueue(async () => {
      await this.reconcileActions(observation.prKey)
      await this.evaluate(observation)
      this.publish([observation.prKey])
    })
  }

  // Status and configuration changes re-derive held work; receipts have a finite recovery deadline.
  reconcile(keys?: Iterable<string>): Promise<void> {
    if (!keys) {
      this.refreshInventory()
    }
    return this.enqueue(() => this.reconcileNow(keys))
  }

  private publish(keys: Iterable<string>): void {
    publishFollowUpProjection(this.deps, this.projection, keys, (affected) =>
      this.reconcile(affected)
    )
  }

  private async reconcileNow(affected?: Iterable<string>): Promise<void> {
    const removed =
      !this.swept && this.deps.inventoryComplete()
        ? this.deps.store.reconcileBindings(this.deps.liveInstanceIds())
        : []
    if (this.deps.inventoryComplete()) {
      this.swept = true
    }
    const keys = new Set(
      affected ?? [...this.deps.store.prs().map((pr) => pr.prKey), ...this.inventory.byPr.keys()]
    )
    for (const key of removed) {
      keys.add(key)
    }
    for (const key of keys) {
      await this.reconcileActions(key)
      const observation = this.deps.source.latest(key)
      if (observation) {
        await this.evaluate(observation, true)
      }
      const pr = this.deps.store.pr(key)
      if (pr) {
        this.deps.store.retire(pr)
      }
    }
    this.publish(keys)
  }

  private reconcileActions(prKey: string): Promise<void> {
    return reconcileFollowUpActions(this.deps, prKey)
  }

  private enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.tail
      .catch(() => undefined)
      .then(async () => {
        if (!this.disposed) {
          await run()
        }
      })
    this.tail = next
    return next
  }

  private evaluate(observation: FollowUpObservation, cached = false): Promise<void> {
    return evaluateFollowUpObservation(this.deps, observation, cached, {
      clearHold: () => this.projection.windowHolds.delete(observation.prKey),
      isDisposed: () => this.disposed,
      hold: (agent) => this.projection.windowHolds.set(observation.prKey, agent),
      mutated: () => this.publish([observation.prKey])
    })
  }

  stop(prKey: string, stopped: boolean): Promise<void> {
    const pr = this.deps.store.pr(prKey)
    if (pr) {
      pr.stoppedAt = stopped ? this.now() : null
      pr.needsBaseline = true
      if (!stopped) {
        pr.consecutiveReadFailures = 0
      }
      this.deps.store.savePr(pr)
    }
    this.publish([prKey])
    void this.reconcile([prKey]).catch((error: unknown) =>
      console.error('[pr-follow-ups] stop reconciliation failed', error)
    )
    return Promise.resolve()
  }

  instanceDeleted(instanceId: string): Promise<void> {
    return this.enqueue(async () => {
      const keys = this.deps.store.deleteBinding(instanceId)
      this.inventory.batch(
        [],
        [...this.inventory.byWorkspace.values()]
          .filter((target) => target.instanceId === instanceId)
          .map((target) => ({ worktreeId: target.worktreeId }))
      )
      for (const key of keys) {
        const pr = this.deps.store.pr(key)
        if (pr) {
          this.deps.store.retire(pr)
        }
      }
      this.publish(keys)
    })
  }

  activityObserved(
    worktreeId: string,
    identity: string,
    working: boolean | 'unknown',
    at: number
  ): string[] | undefined {
    const keys = this.activityRouter.admit(
      worktreeId,
      identity,
      working === 'unknown' ? 'unknown' : working ? 'working' : 'idle',
      at
    )
    if (!keys.length) {
      return undefined
    }
    return keys
  }

  snapshot() {
    return Object.fromEntries(this.projection.entries)
  }

  targetsChanged(
    targets: readonly FollowUpTarget[],
    removals: readonly { worktreeId: string; workspaceRemains?: boolean }[]
  ): Set<string> {
    return this.inventory.batch(targets, removals)
  }

  targetChanged(target: FollowUpTarget): string[] {
    return this.inventory.targetChanged(target)
  }

  forWorkspace(worktreeId: string): { prKey: string; view: FollowUpView; fixing: boolean } | null {
    return this.projection.entries.get(worktreeId) ?? null
  }

  view(prKey: string): FollowUpView {
    const target =
      eligibleFollowUpTargets(this.deps, prKey)[0] ?? this.inventory.byPr.get(prKey)?.[0]
    return (
      (target ? this.projection.entries.get(target.worktreeId)?.view : undefined) ??
      followUpView({ pending: [], used: 0, recentStarts: [] }, this.deps.globalSettings())
    )
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.()
    this.deps.store.actionCommitted = undefined
    this.disposed = true
    await this.tail
    for (const deadline of this.projection.recoveryDeadlines.values()) {
      clearTimeout(deadline.timer)
    }
    this.projection.recoveryDeadlines.clear()
  }
}
