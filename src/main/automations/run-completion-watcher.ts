import {
  isFinalAutomationRunStatus,
  type AutomationDispatchResult,
  type AutomationRun,
  type AutomationRunOutputSnapshot
} from '../../shared/automations-types'
import type { AutomationRunFailureCodeFields } from '../../shared/automation-run-failure-copy'
import { RetainedRunReconciler } from './retained-run-reconciliation'

export type AutomationRunCompletionObservation = {
  status: 'completed' | 'dispatch_failed'
  outputSnapshot?: AutomationRunOutputSnapshot | null
  error?: string | null
} & AutomationRunFailureCodeFields

export type AutomationRunTerminalObserver = {
  /** Null also covers terminals that have not reattached yet. */
  resolveRunTerminal: (run: AutomationRun) => string | null
  observeCompletion: (
    handle: string,
    options: { signal: AbortSignal; run?: AutomationRun }
  ) => Promise<AutomationRunCompletionObservation>
}

export function describeStrandedAutomationRun(run: AutomationRun): string {
  if (run.status === 'pending') {
    return 'Orca stopped before this run could launch.'
  }
  if (run.status === 'dispatching') {
    return 'Orca stopped before this run reported that its agent started.'
  }
  return 'Orca lost the terminal for this run before it reported completion.'
}

// Log transport tokens while keeping run history readable.
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
      strand: (run) => this.strand(run)
    })
  }

  private strand(run: AutomationRun): void {
    void this.finalize(run, {
      status: 'dispatch_failed',
      error: describeStrandedAutomationRun(run)
    }).catch((error) => {
      console.error('[automations] failed to reconcile stranded run:', error)
    })
  }

  /** Leave unresolved terminals for startup reconciliation. */
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
      observation = await this.observer.observeCompletion(handle, {
        signal: controller.signal,
        run
      })
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

  /** Fail unclaimed rows now (no lane survives startup); reattach launched ones within the ready-surface grace. */
  reconcileRetainedRuns(runs: readonly AutomationRun[]): void {
    for (const run of runs) {
      if (run.status === 'pending') {
        this.strand(run)
      }
    }
    this.reconciler.reconcile(
      runs.filter((run) => run.status === 'dispatched' || run.status === 'dispatching')
    )
  }

  /** Call after renderer attachment or headless PTY adoption. */
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
    // Preserve a final result already recorded.
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
