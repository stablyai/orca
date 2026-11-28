import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import type { Store } from '../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { AutomationService } from '../automation-service'
import { createRunTerminalRetention, type RunTerminalRetention } from './run-terminal-retention'
import { runPaneKeepsRunPty, runTabWasFocused } from './run-terminal-workspace-session'

export type RunOwnHandleRuntime = Pick<
  OrcaRuntimeService,
  'getTerminalHandleForPaneKey' | 'getTerminalPtyIdForHandle' | 'getPtyLivenessVerdict'
>

export function runOwnHandle(runtime: RunOwnHandleRuntime, run: AutomationRun): string | null {
  const handle = run.terminalPaneKey
    ? runtime.getTerminalHandleForPaneKey(run.terminalPaneKey)
    : null
  // A closed pane's handle still resolves to its PTY for exit waits; only the exit verdict tells.
  return handle &&
    run.terminalPtyId &&
    runtime.getTerminalPtyIdForHandle(handle) === run.terminalPtyId &&
    runtime.getPtyLivenessVerdict(run.terminalPtyId)?.status !== 'exited'
    ? handle
    : null
}

export function createRuntimeRunTerminalRetention(
  service: AutomationService,
  store: Store,
  runtime: OrcaRuntimeService
): RunTerminalRetention {
  return createRunTerminalRetention({
    listRuns: () => store.listAutomationRuns(),
    terminalClientUse: (run) => {
      if (runTabWasFocused(runtime, run)) {
        return 'used'
      }
      return run.terminalPtyId ? runtime.readTerminalClientUse(run.terminalPtyId) : 'unknown'
    },
    runTerminalAlive: (run) => runOwnHandle(runtime, run) !== null,
    runPaneKept: (run) => runPaneKeepsRunPty(runtime, run),
    shellAloneAtPrompt: (run) =>
      run.terminalPtyId
        ? runtime.confirmTerminalShellAlone(run.terminalPtyId)
        : Promise.resolve(false),
    closeRunTerminal: async (run) => {
      const handle = runOwnHandle(runtime, run)
      if (!handle) {
        return false
      }
      // Preserve user-created splits in the same tab.
      await runtime.closeTerminal(handle)
      return true
    },
    // Shared workspaces must close run panes rather than accumulate sleeping tabs.
    runOwnsWorkspace: (run) => {
      const provenance = run.workspaceId
        ? store.getWorktreeMeta(run.workspaceId)?.automationProvenance
        : undefined
      // Why: a client-origin label names another owner's run, never one of this host's.
      return provenance?.origin !== 'client' && provenance?.automationRunId === run.id
    },
    sleepRunWorkspace: async (run) => {
      const ptyId = run.terminalPtyId
      if (!run.workspaceId || !ptyId) {
        return false
      }
      try {
        // Sleep only this PTY, preserving other live terminals and the agent resume state.
        const sleep = await runtime.sleepTerminalsForWorktree(`id:${run.workspaceId}`, {
          soleLivePtyId: ptyId
        })
        // A retry may find no live PTYs if an earlier sleep stopped the process before failing.
        const slept =
          sleep.livePtyIds.length === 0 ||
          (sleep.stoppedPtyIds.includes(ptyId) && !sleep.remainingLivePtyIds?.includes(ptyId))
        if (!slept) {
          return false
        }
      } catch (error) {
        console.error('[automations] could not sleep a run workspace:', error)
        return false
      }
      // Preserve tab and pane keys for resuming the slept agent.
      await service.markDispatchResult({ runId: run.id, status: run.status, terminalPtyId: null })
      return true
    },
    inAutomationLane: (automationId, operation) =>
      service.runInAutomationLane(automationId, operation),
    forgetRunTerminal: async (run, keepPane) => {
      // An idle shell proves a dispatched run exited without a completion result.
      const unfinished = run.status === 'dispatched'
      await service.markDispatchResult({
        runId: run.id,
        status: unfinished ? 'dispatch_failed' : run.status,
        error: unfinished
          ? (run.error ?? 'The agent exited without reporting completion.')
          : run.error,
        ...(keepPane ? {} : { terminalSessionId: null, terminalPaneKey: null }),
        terminalPtyId: null
      })
    }
  })
}
