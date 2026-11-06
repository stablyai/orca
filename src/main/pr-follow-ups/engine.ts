import { evaluateFollowUpObservation } from './observation'
import { createFollowUpProjectionState, publishFollowUpProjection } from './projection'
import { recordFollowUpActivity, reconcileFollowUpActions } from './action-lifecycle'
import type {
  FollowUpObservation,
  FollowUpView,
  FollowUpTarget,
  FollowUpAction
} from '../../shared/pr-follow-ups/contracts'
import type { FollowUpEngineDependencies } from './engine-contract'
export type { FollowUpEngineDependencies, FollowUpReceipt } from './engine-contract'
import { eligibleFollowUpTargets, followUpView } from './follow-up-state'

export class FollowUpEngine {
  private tail: Promise<void> = Promise.resolve()
  private unsubscribe?: () => void
  private disposed = false
  private swept = false
  private readonly inventoryKeys = new Map<string, string>()
  private readonly projection = createFollowUpProjectionState()
  activePrKeys(): string[] {
    return [...this.projection.activeKeys]
  }
  private readonly byPr = new Map<string, FollowUpTarget[]>()
  private readonly byWorkspace = new Map<string, FollowUpTarget>()

  get waitingForWindow(): boolean {
    return this.projection.windowHolds.size > 0
  }

  private readonly deps: FollowUpEngineDependencies
  constructor(private readonly host: FollowUpEngineDependencies) {
    this.deps = {
      ...host,
      targets: (key) => (key ? (this.byPr.get(key) ?? []) : [...this.byWorkspace.values()])
    }
    this.refreshInventory()
  }

  refreshInventory(): Set<string> {
    const before = new Map(this.inventoryKeys)
    this.inventoryKeys.clear()
    const affected = new Set<string>()
    const previous = new Map(this.byWorkspace)
    this.byPr.clear()
    this.byWorkspace.clear()
    for (const target of this.host.targets()) {
      this.byWorkspace.set(target.worktreeId, target)
      this.inventoryKeys.set(target.worktreeId, JSON.stringify(target))
      const items = this.byPr.get(target.prKey) ?? []
      items.push(target)
      this.byPr.set(target.prKey, items)
      if (before.get(target.worktreeId) !== JSON.stringify(target)) {
        affected.add(target.prKey)
        const old = before.get(target.worktreeId)
        if (old) {
          affected.add(JSON.parse(old).prKey)
        }
      }
      previous.delete(target.worktreeId)
    }
    for (const old of previous.values()) {
      affected.add(old.prKey)
      this.projection.entries.delete(old.worktreeId)
    }
    const ids = new Set(this.host.workspaceIds())
    this.projection.inventoryProjection = JSON.stringify([...ids])
    for (const id of this.projection.entries.keys()) {
      if (!ids.has(id)) {
        this.projection.entries.delete(id)
      }
    }
    for (const id of ids) {
      if (!this.projection.entries.has(id)) {
        this.projection.entries.set(id, null)
      }
    }
    return affected
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
      !this.byPr.get(observation.prKey)?.length &&
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
      affected ?? [...this.deps.store.prs().map((pr) => pr.prKey), ...this.byPr.keys()]
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

  private activity(action: FollowUpAction, working: boolean | 'unknown', at: number): boolean {
    if (action.sessionEndedAt !== undefined) {
      for (const identity of [action.sessionId, action.paneKey, action.terminalPtyId]) {
        if (identity) {
          this.projection.identityPrKeys.delete(identity)
        }
      }
    }
    return recordFollowUpActivity(this.deps, action, working, at)
  }

  private reconcileActions(prKey: string): Promise<void> {
    return reconcileFollowUpActions(this.deps, prKey, (action, working, at) =>
      this.activity(action, working, at)
    )
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
      for (const key of keys) {
        this.byPr.set(
          key,
          (this.byPr.get(key) ?? []).filter((target) => {
            if (target.instanceId !== instanceId) {
              return true
            }
            this.byWorkspace.delete(target.worktreeId)
            this.projection.entries.delete(target.worktreeId)
            return false
          })
        )
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
  ): Promise<void> {
    const key =
      this.projection.identityPrKeys.get(identity) ?? this.byWorkspace.get(worktreeId)?.prKey
    if (!key) {
      return Promise.resolve()
    }
    return this.enqueue(async () => {
      let changed = false
      for (const action of this.deps.store.actions(key, true)) {
        if (
          action.status === 'accepted' &&
          [action.sessionId, action.paneKey, action.terminalPtyId].includes(identity)
        ) {
          changed = this.activity(action, working, at) || changed
        }
      }
      if (!this.byWorkspace.has(worktreeId)) {
        await this.reconcileNow([key])
      } else if (changed) {
        this.publish([key])
      }
    })
  }

  sessionEnded(identity: string, endedAt: number): Promise<void> {
    return this.enqueue(async () => {
      const keys = new Set<string>()
      for (const action of this.deps.store.actionsForIdentity(identity)) {
        if (action.status === 'accepted' && action.sessionEndedAt === undefined) {
          action.sessionEndedAt = endedAt
          this.deps.store.saveAction(action)
          this.activity(action, false, endedAt)
          keys.add(action.prKey)
        }
      }
      await this.reconcileNow(keys)
    })
  }

  snapshot() {
    return Object.fromEntries(this.projection.entries)
  }

  targetChanged(target: FollowUpTarget): string[] {
    const saved = this.inventoryKeys.get(target.worktreeId)
    const old: FollowUpTarget | undefined = saved ? JSON.parse(saved) : undefined
    if (saved === JSON.stringify(target)) {
      return []
    }
    if (old) {
      this.byPr.set(
        old.prKey,
        (this.byPr.get(old.prKey) ?? []).filter((item) => item.worktreeId !== old.worktreeId)
      )
    }
    this.byWorkspace.set(target.worktreeId, target)
    this.inventoryKeys.set(target.worktreeId, JSON.stringify(target))
    this.byPr.set(target.prKey, [...(this.byPr.get(target.prKey) ?? []), target])
    return old ? [old.prKey, target.prKey] : [target.prKey]
  }

  forWorkspace(worktreeId: string): { prKey: string; view: FollowUpView; fixing: boolean } | null {
    return this.projection.entries.get(worktreeId) ?? null
  }

  view(prKey: string): FollowUpView {
    const target = eligibleFollowUpTargets(this.deps, prKey)[0] ?? this.byPr.get(prKey)?.[0]
    return (
      (target ? this.projection.entries.get(target.worktreeId)?.view : undefined) ??
      followUpView({ pending: [], used: 0, recentStarts: [] }, this.deps.globalSettings())
    )
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.()
    this.disposed = true
    await this.tail
    for (const deadline of this.projection.recoveryDeadlines.values()) {
      clearTimeout(deadline.timer)
    }
    this.projection.recoveryDeadlines.clear()
  }
}
