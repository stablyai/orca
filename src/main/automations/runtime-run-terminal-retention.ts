import type { AutomationService } from './service'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { createHeadlessRunTerminalRetention } from './headless-run-terminal-retention'
import { runOwnHandle } from './headless-automation-agent-launch'

export function bindHeadlessRunTerminalRetention(
  service: AutomationService,
  store: Store,
  runtime: OrcaRuntimeService
): void {
  const retainedTarget = (run: Parameters<typeof runOwnHandle>[1]) => {
    const current = store.listAutomationRuns(run.automationId).find((entry) => entry.id === run.id)
    return current &&
      current.workspaceId === run.workspaceId &&
      current.status === run.status &&
      current.terminalPaneKey === run.terminalPaneKey &&
      current.terminalPtyId === run.terminalPtyId
      ? current
      : null
  }
  const retention = createHeadlessRunTerminalRetention({
    listRuns: () => store.listAutomationRuns(),
    terminalClientUse: (run) =>
      run.terminalPtyId ? runtime.readTerminalClientUse(run.terminalPtyId) : 'unknown',
    terminalIncarnation: (run) => {
      const handle = runOwnHandle(runtime, run)
      return handle ? runtime.getTerminalProcessIncarnation(handle) : null
    },
    runTerminalAlive: (run) => runOwnHandle(runtime, run) !== null,
    wholePaneClear: (run, allowEmpty = false) => {
      const handle = runOwnHandle(runtime, run)
      if (!handle || !run.terminalPaneKey) {
        return false
      }
      const identity = runtime.readObservedAgentStatusPaneIdentityFn(run.terminalPaneKey)
      if (
        identity.kind !== 'observed' ||
        identity.terminalHandle !== handle ||
        runtime.getTerminalProcessIncarnation(handle) !== identity.processIncarnation
      ) {
        return false
      }
      const rows = runtime
        .getAgentStatusRowsForPane(run.terminalPaneKey)
        .filter((row) => !row.providerSessionOnly)
      return (
        (allowEmpty || rows.length > 0) &&
        rows.every(
          (row) =>
            !row.restoredUnconfirmed &&
            !row.isReplay &&
            row.connectionId === null &&
            (!row.terminalHandle || row.terminalHandle === handle) &&
            row.state === 'done' &&
            !row.sessionBoundary &&
            !row.claudeTaskWakeupPending &&
            row.subagents?.some((child) => child.state !== 'idle') !== true
        )
      )
    },
    shellAloneAtPrompt: (run) =>
      run.terminalPtyId
        ? runtime.confirmTerminalShellAlone(run.terminalPtyId)
        : Promise.resolve(false),
    closeRunTerminal: async (run, assertSafe) => {
      const handle = runOwnHandle(runtime, run)
      if (!handle || !retainedTarget(run)) {
        return false
      }
      // Preserve user-created splits in the same tab.
      if (runtime.readTerminalClientUse(run.terminalPtyId ?? '') !== 'unused') {
        return false
      }
      await runtime.closeTerminal(handle, { beforeAction: assertSafe })
      return true
    },
    // Shared workspaces must close run panes rather than accumulate sleeping tabs.
    runOwnsWorkspace: (run) => {
      const provenance = run.workspaceId
        ? store.getWorktreeMeta(run.workspaceId)?.automationProvenance
        : undefined
      return provenance?.origin !== 'client' && provenance?.automationRunId === run.id
    },
    sleepRunWorkspace: async (run, assertSafe) => {
      const ptyId = run.terminalPtyId
      if (!run.workspaceId || !ptyId || !retainedTarget(run)) {
        return false
      }
      try {
        // Sleep only this PTY, preserving other live terminals and the agent resume state.
        const sleep = await runtime.sleepTerminalsForWorktree(`id:${run.workspaceId}`, {
          soleLivePtyId: ptyId,
          beforeAction: assertSafe
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
      if (!retainedTarget(run)) {
        return false
      }
      // Preserve tab and pane keys for resuming the slept agent.
      await service.markDispatchResult({ runId: run.id, status: run.status, terminalPtyId: null })
      return true
    },
    inAutomationLane: (automationId, operation) =>
      service.runInAutomationLane(automationId, operation),
    forgetRunTerminal: async (run) => {
      if (!retainedTarget(run)) {
        return
      }
      await service.markDispatchResult({
        runId: run.id,
        status: run.status,
        error: run.error,
        terminalSessionId: null,
        terminalPaneKey: null,
        terminalPtyId: null
      })
    }
  })
  service.releaseFinishedRunTerminals = () => retention.drain()
  const start = service.start.bind(service)
  const stop = service.stop.bind(service)
  service.start = () => {
    start()
    retention.start()
  }
  service.stop = () => {
    retention.stop()
    stop()
  }
}
