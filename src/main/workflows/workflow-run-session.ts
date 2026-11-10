import { advanceWorkflowRun } from '../../shared/workflow/workflow-scheduler'
import { appendWorkflowEvent } from '../../shared/workflow/workflow-run-state'
import { isWorkflowRunTerminal, type WorkflowRun } from '../../shared/workflow/workflow-run-types'
import type { WorkflowOrcaAdapter } from './workflow-orca-adapter-contract'
import type { WorkflowStore } from './workflow-store'

export type WorkflowSessionDeps = {
  store: WorkflowStore
  adapter: WorkflowOrcaAdapter
  now: () => Date
  /** Effects the session schedules but does not own (dispatch, approval, finalize). */
  effects: WorkflowSessionEffects
  reconcileIntervalMs: number
}

export type WorkflowSessionEffects = {
  dispatchAgent(session: WorkflowRunSession, taskKey: string): Promise<void>
  requestApproval(session: WorkflowRunSession, taskKey: string): Promise<void>
  finalize(session: WorkflowRunSession): Promise<void>
  reconcile(session: WorkflowRunSession): Promise<void>
  pumpMail(session: WorkflowRunSession): Promise<void>
}

const MAX_STORED_EVENTS = 5_000
/** A quiet run's backstop slows to this multiple of the base interval. */
const MAX_RECONCILE_BACKOFF = 10

/**
 * One run's serial executor. State changes happen inside exclusive() turns that never await an
 * Orca call mid-mutation; Orca effects run between turns and re-enter with their results.
 */
export class WorkflowRunSession {
  private chain: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  unregisterRouteGuard: (() => void) | null = null

  constructor(
    readonly run: WorkflowRun,
    readonly deps: WorkflowSessionDeps
  ) {}

  at(): string {
    return this.deps.now().toISOString()
  }

  get isClosed(): boolean {
    return this.closed
  }

  exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  persist(): void {
    if (this.run.events.length > MAX_STORED_EVENTS) {
      this.run.events.splice(0, this.run.events.length - MAX_STORED_EVENTS)
    }
    this.deps.store.saveRun(this.run).catch((error: unknown) => {
      console.error('[workflows] failed to persist run', this.run.id, error)
    })
  }

  warn(message: string, refs: Parameters<typeof appendWorkflowEvent>[4] = {}): void {
    appendWorkflowEvent(this.run, 'warning', this.at(), message, refs)
  }

  /** Advance the deterministic scheduler and start the effects it returns, each exactly once. */
  schedule(): Promise<void> {
    return this.exclusive(() => {
      if (this.closed) {
        return
      }
      const actions = advanceWorkflowRun(this.run, this.at())
      this.persist()
      for (const action of actions) {
        const effect =
          action.kind === 'dispatch-agent'
            ? this.deps.effects.dispatchAgent(this, action.taskKey)
            : action.kind === 'request-approval'
              ? this.deps.effects.requestApproval(this, action.taskKey)
              : this.deps.effects.finalize(this)
        effect.catch((error: unknown) => this.reportEffectError(error))
      }
    })
  }

  private reportEffectError(error: unknown): void {
    void this.exclusive(() => {
      this.warn(
        `Controller effect failed: ${error instanceof Error ? error.message : String(error)}`
      )
      this.persist()
    })
  }

  /** Begin watching Orca: a mail pump for prompt wakes and a reconcile tick as the backstop. */
  startObserving(): void {
    if (this.timer || this.closed) {
      return
    }
    this.scheduleReconcile(this.deps.reconcileIntervalMs, this.lastEventSeq())
    this.deps.effects.pumpMail(this).catch((error: unknown) => this.reportEffectError(error))
  }

  /** Mail wakes carry the prompt path, so the backstop backs off while the run stays quiet. */
  private scheduleReconcile(delayMs: number, seenSeq: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      void this.deps.effects
        .reconcile(this)
        .catch((error: unknown) => this.reportEffectError(error))
        .then(() => {
          if (this.closed || this.terminal) {
            return
          }
          const base = this.deps.reconcileIntervalMs
          const seq = this.lastEventSeq()
          const next = seq === seenSeq ? Math.min(delayMs * 2, base * MAX_RECONCILE_BACKOFF) : base
          this.scheduleReconcile(next, seq)
        })
    }, delayMs)
    this.timer.unref?.()
  }

  private lastEventSeq(): number {
    return this.run.events.at(-1)?.seq ?? -1
  }

  close(): void {
    this.closed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.unregisterRouteGuard?.()
    this.unregisterRouteGuard = null
  }

  get terminal(): boolean {
    return isWorkflowRunTerminal(this.run.status)
  }
}
