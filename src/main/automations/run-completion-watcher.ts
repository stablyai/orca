import {
  describeStrandedAutomationRun,
  describeObservationError,
  sameTerminal,
  type AutomationRunCompletionObservation,
  type AutomationRunTerminalObserver,
  type AutomationRunWatchEntry,
  type AutomationRunWatchReservation
} from './automation-run-completion-contract'
export type {
  AutomationRunCompletionObservation,
  AutomationRunTerminalObserver,
  AutomationRunSubmission,
  AutomationRunWatchReservation
} from './automation-run-completion-contract'
export { describeStrandedAutomationRun } from './automation-run-completion-contract'
import {
  isFinalAutomationRunStatus,
  type AutomationDispatchResult,
  type AutomationRun
} from '../../shared/automations-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { RetainedRunReconciler } from './retained-run-reconciliation'
import { isAutomationRunHistory } from '../../shared/automation-run-retention'

export class AutomationRunCompletionWatcher {
  private readonly observer: AutomationRunTerminalObserver
  private readonly readRun: (automationId: string, runId: string) => AutomationRun | null
  private readonly markDispatchResult: (result: AutomationDispatchResult) => Promise<unknown>
  private readonly watching = new Map<string, AutomationRunWatchEntry>()
  private readonly reconciler: RetainedRunReconciler
  private disposed = false

  constructor(opts: {
    observer: AutomationRunTerminalObserver
    readRun: (automationId: string, runId: string) => AutomationRun | null
    markDispatchResult: (result: AutomationDispatchResult) => Promise<unknown>
  }) {
    this.observer = opts.observer
    this.readRun = opts.readRun
    this.markDispatchResult = opts.markDispatchResult
    this.reconciler = new RetainedRunReconciler({
      attach: (run) => this.attachRetainedRun(run),
      stillRetained: (run) => {
        const current = this.readRun(run.automationId, run.id)
        return Boolean(current && !isFinalAutomationRunStatus(current.status))
      },
      strand: (run) => {
        if (isAutomationRunHistory(run)) {
          return
        }
        void this.finalize(run, {
          status: 'dispatch_failed',
          error: describeStrandedAutomationRun(run)
        }).catch((error) => {
          console.error('[automations] failed to reconcile stranded run:', error)
        })
      }
    })
  }

  /** Reserve cancellation and buffering before invoking the launch owner. */
  reserve(run: AutomationRun, prompt: string, agent: TuiAgent): AutomationRunWatchReservation {
    this.forget(run.id)
    const entry: AutomationRunWatchEntry = {
      controller: new AbortController(),
      run,
      adopted: false,
      submission: { prompt, agent, submitted: false }
    }
    entry.submission!.current = () => this.current(entry)
    this.watching.set(run.id, entry)
    if (this.disposed) {
      this.forget(run.id)
    }
    return {
      signal: entry.controller.signal,
      assertCurrent: () => {
        if (!this.current(entry)) {
          entry.controller.abort()
          throw new Error('request_aborted')
        }
      },
      bind: (bound, handle, current) => {
        if (!this.current(entry)) {
          return
        }
        entry.observationController?.abort()
        entry.run = { ...entry.run, ...bound }
        entry.handle = handle
        entry.targetCurrent = current
        entry.result = undefined
        this.startWatch(entry, handle)
      },
      submitted: () => {
        if (!this.current(entry) || !entry.submission) {
          return
        }
        entry.submission.submitted = true
        entry.submission.onSubmit?.()
      },
      deliverySettled: () => {
        if (!this.current(entry)) {
          this.forget(run.id)
          return
        }
        if (this.watching.get(run.id) !== entry || entry.submission?.submitted) {
          return
        }
        entry.observationController?.abort()
        entry.result = null
        if (entry.adopted) {
          void this.finish(entry)
        }
      },
      release: () => {
        if (this.watching.get(run.id) === entry) {
          this.forget(run.id)
        }
      }
    }
  }

  watch(run: AutomationRun, recovery = false): void {
    if (this.disposed) {
      return
    }
    const entry = this.watching.get(run.id)
    if (entry) {
      entry.run = run
      entry.adopted = true
      if (entry.result !== undefined) {
        void this.finish(entry)
      }
      return
    }
    const handle = this.observer.resolveRunTerminal(run)
    if (handle) {
      const attached: AutomationRunWatchEntry = {
        controller: new AbortController(),
        run,
        adopted: true,
        recovery
      }
      this.watching.set(run.id, attached)
      this.startWatch(attached, handle)
    }
  }

  /** Called by existing Store publication: eviction/finality revokes before an acknowledgement. */
  retain(runs: readonly AutomationRun[]): void {
    const current = new Map(runs.map((run) => [run.id, run]))
    for (const [id, entry] of this.watching) {
      const run = current.get(id)
      if (
        !run ||
        isFinalAutomationRunStatus(run.status) ||
        (entry.adopted && !sameTerminal(entry.run, run))
      ) {
        this.forget(id)
      }
    }
  }

  private current(entry: AutomationRunWatchEntry): boolean {
    const run = this.readRun(entry.run.automationId, entry.run.id)
    return (
      !this.disposed &&
      this.watching.get(entry.run.id) === entry &&
      !entry.controller.signal.aborted &&
      entry.targetCurrent?.() !== false &&
      Boolean(
        run &&
        !isFinalAutomationRunStatus(run.status) &&
        (!entry.adopted || sameTerminal(entry.run, run))
      )
    )
  }

  private attachRetainedRun(run: AutomationRun): boolean {
    if (this.disposed) {
      return false
    }
    if (this.watching.has(run.id)) {
      return true
    }
    const handle = this.observer.resolveRunTerminal(run)
    if (!handle) {
      return isAutomationRunHistory(run)
    }
    this.watch(run, true)
    return true
  }

  private startWatch(entry: AutomationRunWatchEntry, handle: string): void {
    const controller = new AbortController()
    entry.observationController = controller
    const abort = () => controller.abort()
    entry.controller.signal.addEventListener('abort', abort, { once: true })
    void this.observer
      .observeCompletion(handle, {
        signal: controller.signal,
        run: entry.run,
        submission: entry.submission,
        recovery: entry.recovery
      })
      .then(
        (result) => {
          if (
            !this.current(entry) ||
            controller.signal.aborted ||
            entry.observationController !== controller
          ) {
            return
          }
          entry.result = result
          return entry.adopted ? this.finish(entry) : undefined
        },
        (error) => {
          if (!this.current(entry) || controller.signal.aborted) {
            return
          }
          entry.result =
            entry.submission || (entry.recovery && entry.run.sessionKind !== 'chat')
              ? null
              : { status: 'dispatch_failed', error: describeObservationError(error) }
          return entry.adopted ? this.finish(entry) : undefined
        }
      )
      .catch((error) => console.error('[automations] failed to persist watched completion:', error))
      .finally(() => {
        entry.controller.signal.removeEventListener('abort', abort)
        if (this.watching.get(entry.run.id) === entry && !this.current(entry)) {
          this.forget(entry.run.id)
        }
      })
  }

  private async finish(entry: AutomationRunWatchEntry): Promise<void> {
    if (!this.current(entry) || entry.result === undefined) {
      return
    }
    const result = entry.result
    try {
      if (result && entry.submission?.sourceCurrent?.() !== false) {
        await this.finalize(entry.run, result)
      }
    } finally {
      if (this.watching.get(entry.run.id) === entry) {
        this.forget(entry.run.id)
      }
    }
  }

  forget(runId: string): void {
    const entry = this.watching.get(runId)
    this.watching.delete(runId)
    entry?.controller.abort()
    entry?.observationController?.abort()
    if (entry?.submission) {
      entry.submission.onSubmit = undefined
    }
  }

  /** Reattach surviving sessions; defer unresolved runs until the ready-surface grace expires. */
  reconcileRetainedRuns(runs: readonly AutomationRun[]): void {
    this.reconciler.reconcile(
      runs.filter(
        (run) =>
          run.status === 'dispatched' ||
          run.status === 'dispatching' ||
          (run.status === 'pending' && run.trigger === 'manual')
      )
    )
  }

  /** Call after renderer attachment or headless PTY adoption. */
  markTerminalSurfaceReady(): void {
    this.reconciler.markSurfaceReady()
  }

  dispose(): void {
    this.disposed = true
    this.reconciler.dispose()
    for (const id of this.watching.keys()) {
      this.forget(id)
    }
  }

  private async finalize(
    run: AutomationRun,
    observation: AutomationRunCompletionObservation
  ): Promise<void> {
    // Preserve a final result already reported by the renderer.
    const current = this.readRun(run.automationId, run.id)
    if (!current || isFinalAutomationRunStatus(current.status)) {
      return
    }
    await this.markDispatchResult({
      runId: run.id,
      status: observation.status,
      workspaceId: current.workspaceId,
      sessionKind: current.sessionKind,
      chatSessionId: current.chatSessionId,
      terminalSessionId: current.terminalSessionId,
      terminalPaneKey: current.terminalPaneKey,
      terminalPtyId: current.terminalPtyId,
      outputSnapshot: observation.outputSnapshot ?? null,
      error: observation.error ?? null,
      errorCode: observation.errorCode ?? null,
      errorParams: observation.errorParams ?? null
    })
  }
}
