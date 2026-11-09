import {
  isFinalAutomationRunStatus,
  type AutomationDispatchResult,
  type AutomationRun,
  type AutomationRunOutputSnapshot
} from '../../shared/automations/history/automation-run'
import type { AutomationRunFailureCodeFields } from '../../shared/automations/history/automation-run-failure-copy'
import { RetainedRunReconciler } from './retained-run-reconciliation'
import {
  ShellRunTerminalBindings,
  type ShellRunTerminalBinding
} from './shell-run-terminal-binding'

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
    options: {
      signal: AbortSignal
      run?: AutomationRun
      onCommandExit?: (exitCode: number) => void
      onUnverifiable?: (outputSnapshot: AutomationRunOutputSnapshot | null) => void
    }
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
  private readonly shellRuns = new ShellRunTerminalBindings()
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
      canStrand: (run) => run.completionCondition !== 'exit',
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

  /** Called for every unfinished run update: watch dispatched runs, hold reserved shell panes. */
  track(run: AutomationRun): void {
    this.shellRuns.remember(run)
    if (run.status === 'dispatched') {
      this.watch(run)
    }
  }

  /** A registered PTY binds the shell run that reserved its pane, then the run is watched. */
  bindShellRun(binding: ShellRunTerminalBinding): void {
    const run = this.disposed ? null : this.shellRuns.claim(binding, this.readRun)
    if (!run) {
      return
    }
    void this.markDispatchResult({
      runId: run.id,
      status: 'dispatched',
      terminalPtyId: binding.ptyId,
      terminalIncarnationId: binding.incarnationId
    }).catch((error) => console.error('[automations] Failed to bind shell run terminal:', error))
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

  private attachRetainedRun(retained: AutomationRun): boolean {
    const run = this.readRun(retained.automationId, retained.id) ?? retained
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
    const recordUnverifiable = (outputSnapshot: AutomationRunOutputSnapshot | null): void => {
      const current = this.readRun(run.automationId, run.id)
      const error = 'Orca cannot verify this command’s completion. Waiting for its execution host.'
      if (!current || isFinalAutomationRunStatus(current.status)) {
        return
      }
      if (
        current.error === error &&
        current.outputSnapshot?.content === outputSnapshot?.content &&
        current.outputSnapshot?.truncated === outputSnapshot?.truncated
      ) {
        return
      }
      void this.markDispatchResult({
        runId: run.id,
        status: current.status,
        outputSnapshot,
        error
      }).catch((error) =>
        console.error('[automations] Failed to save pending shell evidence:', error)
      )
    }
    try {
      observation = await this.observer.observeCompletion(handle, {
        signal: controller.signal,
        run,
        onCommandExit: (exitCode) => {
          const current = this.readRun(run.automationId, run.id)
          if (
            !current ||
            isFinalAutomationRunStatus(current.status) ||
            current.terminalCommandExitCode === exitCode
          ) {
            return
          }
          void this.markDispatchResult({
            runId: run.id,
            status: current.status,
            terminalCommandExitCode: exitCode
          }).catch((error) =>
            console.error('[automations] Failed to save command exit receipt:', error)
          )
        },
        onUnverifiable: recordUnverifiable
      })
    } catch (error) {
      if (controller.signal.aborted) {
        return
      }
      if (run.completionCondition === 'exit') {
        recordUnverifiable(this.readRun(run.automationId, run.id)?.outputSnapshot ?? null)
        this.watching.delete(run.id)
        this.reconciler.reconcile([run], true)
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
    this.shellRuns.forget(runId)
    this.watching.get(runId)?.abort()
    this.watching.delete(runId)
  }

  /** Fail unclaimed rows now (no lane survives startup); reattach launched ones within the ready-surface grace. */
  reconcileRetainedRuns(runs: readonly AutomationRun[]): void {
    for (const run of runs) {
      if (run.status === 'pending') {
        this.strand(run)
      } else if (run.completionCondition === 'exit' && !isFinalAutomationRunStatus(run.status)) {
        this.shellRuns.remember(run)
        void this.markDispatchResult({
          runId: run.id,
          status: run.status,
          error: 'Orca is waiting for the execution host to confirm this command’s completion.'
        }).catch((error) =>
          console.error('[automations] Failed to mark retained shell run:', error)
        )
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
