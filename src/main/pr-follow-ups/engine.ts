import { dispatchFollowUp, settleFollowUpReceipt } from './dispatch'
import type { FollowUpObservation, FollowUpView } from '../../shared/pr-follow-ups/contracts'
import type { FollowUpEngineDependencies } from './engine-contract'
export type { FollowUpEngineDependencies, FollowUpReceipt } from './engine-contract'
import { eligibleFollowUpTargets, followUpView } from './follow-up-state'

export class FollowUpEngine {
  private tail: Promise<void> = Promise.resolve()
  private unsubscribe?: () => void
  private disposed = false
  private readonly windowHolds = new Map<string, string>()

  get waitingForWindow(): boolean {
    return this.windowHolds.size > 0
  }

  constructor(private readonly deps: FollowUpEngineDependencies) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  start(): Promise<void> {
    this.unsubscribe = this.deps.source.subscribe((observation) => {
      void this.observe(observation).catch((error: unknown) =>
        console.error('[pr-follow-ups] observation failed', error)
      )
    })
    return this.enqueue(() => this.reconcileNow())
  }

  observe(observation: FollowUpObservation): Promise<void> {
    return this.enqueue(async () => {
      await this.reconcileActions(observation.prKey)
      await this.evaluate(observation)
    })
  }

  // Settings, workspace lifecycle and agent-status changes re-derive held work without a timer.
  reconcile(): Promise<void> {
    return this.enqueue(() => this.reconcileNow())
  }

  private async reconcileNow(): Promise<void> {
    for (const pr of this.deps.store.prs()) {
      await this.reconcileActions(pr.prKey)
    }
    this.deps.store.reconcileBindings(this.deps.liveInstanceIds())
    for (const pr of this.deps.store.prs()) {
      this.deps.store.retire(pr)
    }
    const keys = new Set([
      ...this.deps.store.prs().map((pr) => pr.prKey),
      ...this.deps.targets().map((target) => target.prKey)
    ])
    for (const key of keys) {
      const observation = this.deps.source.latest(key)
      if (observation) {
        await this.evaluate(observation, true)
      } else {
        const pr = this.deps.store.pr(key)
        if (pr) {
          this.deps.store.retire(pr)
        }
      }
    }
  }

  private async reconcileActions(prKey: string): Promise<void> {
    for (const action of this.deps.store.actions(prKey)) {
      if (action.status === 'claimed' || action.status === 'unconfirmed') {
        settleFollowUpReceipt(this.deps, action, await this.deps.recover(action))
      }
      if (action.status === 'accepted' && action.sessionEndedAt === undefined) {
        const live = await this.deps.live(action).catch(() => 'unknown' as const)
        if (live === false) {
          action.sessionEndedAt = this.now()
          this.deps.store.saveAction(action)
        }
      }
    }
  }

  private enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.tail
      .catch(() => undefined)
      .then(async () => {
        if (!this.disposed) {
          await run()
        }
        this.deps.changed?.()
      })
    this.tail = next
    return next
  }

  private async evaluate(observation: FollowUpObservation, cached = false): Promise<void> {
    const { store } = this.deps
    this.windowHolds.delete(observation.prKey)
    let pr = store.pr(observation.prKey)
    const targets = eligibleFollowUpTargets(this.deps, observation.prKey)
    if (!pr && (!targets.length || observation.state !== 'open')) {
      return
    }
    pr ??= {
      prKey: observation.prKey,
      baselineAt: null,
      needsBaseline: true,
      headSha: observation.headSha,
      lastSeenAt: 0,
      handled: [],
      baselineNames: [],
      generation: 0,
      stoppedAt: null,
      consecutiveReadFailures: 0,
      consecutiveCommentWakes: 0,
      pendingRead: false,
      state: observation.state
    }
    if (observation.observedAt < pr.lastSeenAt) {
      return
    }
    for (const target of this.deps.targets().filter((target) => target.prKey === pr.prKey)) {
      store.bind(pr.prKey, target.instanceId)
    }
    pr.state = observation.state
    if (!targets.length || pr.stoppedAt !== null || observation.state !== 'open') {
      pr.needsBaseline = true
      store.savePr(pr)
      store.retire(pr)
      return
    }
    // Activation waits for a completed reader observation, not its older cached snapshot.
    if (pr.needsBaseline && cached) {
      store.savePr(pr)
      return
    }
    if (!observation.readComplete) {
      // Reconciliations of a held observation are not additional failed reads.
      if (observation.observedAt > pr.lastSeenAt) {
        pr.consecutiveReadFailures += 1
      }
      pr.pendingRead = true
      pr.lastSeenAt = observation.observedAt
      store.savePr(pr)
      return
    }
    pr.pendingRead = false
    if (pr.consecutiveReadFailures < 8) {
      pr.consecutiveReadFailures = 0
    }
    if (pr.headSha !== observation.headSha) {
      const actions = store.actions(pr.prKey)
      const attributed = this.deps.source
        .pullRequestActionsFor?.(pr.prKey)
        .some(
          (push) =>
            push.headSha === observation.headSha &&
            actions.some(
              (action) =>
                action.status === 'accepted' &&
                (action.sessionId === push.chatId || action.transcriptChatId === push.chatId)
            )
        )
      const overlapped = actions.some(
        (action) =>
          action.status === 'accepted' &&
          action.sessionStartedAt !== undefined &&
          action.sessionStartedAt <= observation.observedAt &&
          (action.sessionEndedAt === undefined || action.sessionEndedAt >= pr.lastSeenAt)
      )
      if (!attributed && !overlapped) {
        pr.generation += 1
      }
      pr.headSha = observation.headSha
      pr.handled = []
      pr.baselineNames = []
    }
    pr.lastSeenAt = observation.observedAt
    if (pr.needsBaseline) {
      pr.baselineAt = observation.observedAt
      pr.needsBaseline = false
      pr.handled = [...new Set([...pr.handled, ...observation.failingCheckNames])]
      pr.baselineNames = [...observation.failingCheckNames]
      store.savePr(pr)
      return
    }
    store.savePr(pr)
    if (!observation.checksFinal) {
      return
    }
    await dispatchFollowUp(this.deps, observation, pr, targets[0]!, {
      isDisposed: () => this.disposed,
      hold: (agent) => this.windowHolds.set(pr.prKey, agent)
    })
  }

  stop(prKey: string, stopped: boolean): Promise<void> {
    const pr = this.deps.store.pr(prKey)
    if (pr) {
      pr.stoppedAt = stopped ? this.now() : null
      pr.needsBaseline = true
      if (!stopped) {
        pr.consecutiveReadFailures = 0
        pr.consecutiveCommentWakes = 0
      }
      this.deps.store.savePr(pr)
    }
    return this.reconcile()
  }

  sessionEnded(identity: string, endedAt: number): Promise<void> {
    return this.enqueue(async () => {
      for (const pr of this.deps.store.prs()) {
        for (const action of this.deps.store.actions(pr.prKey)) {
          if (
            action.status === 'accepted' &&
            action.sessionEndedAt === undefined &&
            [action.sessionId, action.terminalPtyId].includes(identity)
          ) {
            action.sessionEndedAt = endedAt
            this.deps.store.saveAction(action)
          }
        }
      }
      await this.reconcileNow()
    })
  }

  snapshot() {
    return Object.fromEntries(
      this.deps
        .targets()
        .map((target) => [target.worktreeId, this.forWorkspace(target.worktreeId)!])
    )
  }

  forWorkspace(worktreeId: string): { prKey: string; view: FollowUpView; fixing: boolean } | null {
    const target = this.deps.targets().find((item) => item.worktreeId === worktreeId)
    if (!target) {
      return null
    }
    const fixing = this.deps.store
      .actions(target.prKey)
      .some(
        (action) =>
          action.worktreeId === worktreeId &&
          action.status === 'accepted' &&
          action.sessionEndedAt === undefined &&
          this.deps.working(action)
      )
    return { prKey: target.prKey, view: this.view(target.prKey), fixing }
  }

  view(prKey: string): FollowUpView {
    return followUpView(this.deps, prKey, this.windowHolds.has(prKey))
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.()
    this.disposed = true
    await this.tail
  }
}
