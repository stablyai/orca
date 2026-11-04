import { isRendererViewShowingPty } from '../ipc/pty/delivery/visibility-state'
import { getAutomationRunOperations } from '../persistence/loading-store/automation-persistence'
import { readAutomationRunLaunch } from './automation-run-receipt'
import type { AutomationService } from './service'
import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { createHeadlessRunTerminalRetention } from './headless-run-terminal-retention'
import { runOwnHandle } from './headless-automation-agent-launch'

export function bindHeadlessRunTerminalRetention(
  service: AutomationService,
  store: Store,
  runtime: OrcaRuntimeService,
  headless = true
): void {
  // Store replaces this array on mutation; index each source snapshot once per sweep.
  const listRuns = () => getAutomationRunOperations(store).state.automationRuns ?? []
  const retention = createHeadlessRunTerminalRetention({
    listRuns,
    ownsRunTerminal: headless
      ? undefined
      : (run, ancestors) => {
          try {
            const records = runtime.openedAgentSessionRecordStore()
            const handle = runOwnHandle(runtime, run)
            return Boolean(
              records &&
              ancestors.some((creator) => {
                const operation = readAutomationRunLaunch(records, creator, 'fresh-launch')
                const launch = operation?.launch
                return (
                  operation &&
                  operation.expiresAt > Date.now() &&
                  launch?.outcome.kind === 'terminal' &&
                  launch.worktreeId === run.workspaceId &&
                  (launch.outcome.paneKey
                    ? launch.outcome.paneKey === run.terminalPaneKey
                    : handle === launch.outcome.handle) &&
                  (!handle ||
                    (handle === launch.outcome.handle &&
                      runtime.getTerminalWorktreeIdForHandle(launch.outcome.handle) ===
                        run.workspaceId))
                )
              })
            )
          } catch {
            return false
          }
        },
    terminalClientUse: (run) =>
      run.terminalPtyId
        ? isRendererViewShowingPty(run.terminalPtyId)
          ? 'used'
          : runtime.readTerminalClientUse(run.terminalPtyId)
        : 'unknown',
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
      if (!handle) {
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
    sleepRunWorkspace: async (run, assertSafe, assertOwned) => {
      const ptyId = run.terminalPtyId
      if (!run.workspaceId || !ptyId) {
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
      assertOwned()
      // Preserve tab and pane keys for resuming the slept agent.
      await service.markDispatchResult({ runId: run.id, status: run.status, terminalPtyId: null })
      return true
    },
    inAutomationLane: (automationId, operation) =>
      service.runInAutomationLane(automationId, operation),
    forgetRunTerminal: async (run, assertOwned) => {
      assertOwned()
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
