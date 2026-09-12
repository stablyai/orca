import {
  isFinalAutomationRunStatus,
  type AutomationDispatchResult,
  type AutomationRun,
  type AutomationRunOutputSnapshot
} from '../../shared/automations-types'
import { RetainedRunReconciler } from './retained-run-reconciliation'

export type AutomationRunCompletionObservation = {
  status: 'completed' | 'dispatch_failed'
  outputSnapshot?: AutomationRunOutputSnapshot | null
  error?: string | null
}

/** The owning authority's view of a dispatched run's own terminal session. */
export type AutomationRunTerminalObserver = {
  /** Control handle for the run's terminal, or null once the authority lost it. */
  resolveRunTerminal: (run: AutomationRun) => string | null
  observeCompletion: (
    handle: string,
    options: { signal: AbortSignal }
  ) => Promise<AutomationRunCompletionObservation>
}

/** Truthful reason for a run this authority can no longer observe; never claims completion. */
export function describeStrandedAutomationRun(run: AutomationRun): string {
  if (run.status === 'dispatching') {
    return 'Orca stopped before this run reported that its agent started.'
  }
  return 'Orca lost the terminal for this run before it reported completion.'
}

/** Why a fixed sentence: the throws here carry internal transport tokens
 *  (`terminal_handle_stale`, `terminal_not_found`, `request_aborted`), and a run
 *  history row is user copy. The token stays in the log, where it is useful. */
function describeObservationError(error: unknown): string {
  console.error('[automations] run completion observation failed:', error)
  return 'Orca stopped watching this run before it reported completion.'
}

export class AutomationRunCompletionWatcher {
  private readonly observer: AutomationRunTerminalObserver
  private readonly readRun: (automationId: string, runId: string) => AutomationRun | null
  private readonly markDispatchResult: (result: AutomationDispatchResult) => Promise<unknown>
  private readonly watching = new Map<string, AbortController>()
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
        void this.finalize(run, {
          status: 'dispatch_failed',
          error: describeStrandedAutomationRun(run)
        }).catch((error) => {
          console.error('[automations] failed to reconcile stranded run:', error)
        })
      }
    })
  }

  /** Observes a just-dispatched run. A run whose terminal is not resolvable yet
   *  is left alone; startup reconciliation is what resolves stranded runs. */
  watch(run: AutomationRun): void {
    if (this.disposed || this.watching.has(run.id)) {
      return
    }
    const handle = this.observer.resolveRunTerminal(run)
    if (handle) {
      this.startWatch(run, handle)
    }
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
      return false
    }
    this.startWatch(run, handle)
    return true
  }

  private startWatch(run: AutomationRun, handle: string): void {
    const controller = new AbortController()
    this.watching.set(run.id, controller)
    void this.observeUntilTerminal(run, handle, controller).finally(() => {
      if (this.watching.get(run.id) === controller) {
        this.watching.delete(run.id)
      }
    })
  }

  private async observeUntilTerminal(
    run: AutomationRun,
    handle: string,
    controller: AbortController
  ): Promise<void> {
    let observation: AutomationRunCompletionObservation
    try {
      observation = await this.observer.observeCompletion(handle, { signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) {
        return
      }
      observation = { status: 'dispatch_failed', error: describeObservationError(error) }
    }
    try {
      await this.finalize(run, observation)
    } catch (error) {
      console.error('[automations] failed to persist watched run completion:', error)
    }
  }

  forget(runId: string): void {
    this.watching.get(runId)?.abort()
    this.watching.delete(runId)
  }

  /** Startup pass over retained runs: re-attach where the session survived, and
   *  stage the rest — a run is only closed out once the terminal surface has
   *  reported ready and still cannot find it. */
  reconcileRetainedRuns(runs: readonly AutomationRun[]): void {
    this.reconciler.reconcile(
      runs.filter((run) => run.status === 'dispatched' || run.status === 'dispatching')
    )
  }

  /** The authority's terminal surface can now answer pane lookups: desktop
   *  renderer attached, or headless serve finished adopting its PTYs. */
  markTerminalSurfaceReady(): void {
    this.reconciler.markSurfaceReady()
  }

  dispose(): void {
    this.disposed = true
    this.reconciler.dispose()
    for (const controller of this.watching.values()) {
      controller.abort()
    }
    this.watching.clear()
  }

  private async finalize(
    run: AutomationRun,
    observation: AutomationRunCompletionObservation
  ): Promise<void> {
    // Why: the renderer's dispatch observer races this watcher for the same run;
    // re-reading immediately before the write keeps the terminal status single.
    const current = this.readRun(run.automationId, run.id)
    if (!current || isFinalAutomationRunStatus(current.status)) {
      return
    }
    await this.markDispatchResult({
      runId: run.id,
      status: observation.status,
      workspaceId: current.workspaceId,
      terminalSessionId: current.terminalSessionId,
      terminalPaneKey: current.terminalPaneKey,
      terminalPtyId: current.terminalPtyId,
      outputSnapshot: observation.outputSnapshot ?? null,
      error: observation.error ?? null
    })
  }
}
