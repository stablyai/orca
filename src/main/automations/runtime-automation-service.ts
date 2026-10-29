import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { AutomationService } from './service'
import { createHeadlessRunTerminalRetention } from './headless-run-terminal-retention'
import {
  getTuiAgentDetectCommands,
  isTuiAgent,
  TUI_AGENT_CONFIG
} from '../../shared/tui-agent-config'
import { launchHeadlessAutomationAgent, runOwnHandle } from './headless-automation-agent-launch'
import {
  AGENT_HOOKS_REVIEW_BLOCKED_ERROR,
  createRuntimeAutomationRunTerminalObserver
} from './runtime-terminal-run-observer'
import { closeEarlierHookReviewRunTerminals } from './hook-review-blocked-run-terminals'

const MAX_REMEMBERED_LAUNCHES = 256

export function createRuntimeAutomationService(input: {
  store: Store
  runtime: OrcaRuntimeService
  claudeUsage?: ClaudeUsageStore
  codexUsage?: CodexUsageStore
  /** Execute remote_host_service schedules through the headless dispatcher. */
  headless: boolean
}): AutomationService {
  const { store, runtime, claudeUsage, codexUsage } = input
  // Launch handles remain usable before pane-key lookup resolves.
  const launchedHandles = new Map<string, string>()
  const observer = createRuntimeAutomationRunTerminalObserver(runtime, {
    getAgentStatusRowsForPane: (paneKey) => runtime.getAgentStatusRowsForPane(paneKey),
    agentCommandsForRun: (run) =>
      automationAgentCommands(
        store.listAutomations().find((entry) => entry.id === run.automationId)?.agentId
      )
  })
  const service = new AutomationService(store, {
    claudeUsage,
    codexUsage,
    terminalObserver: {
      ...observer,
      resolveRunTerminal: (run) =>
        (run.terminalPaneKey ? launchedHandles.get(run.terminalPaneKey) : undefined) ??
        observer.resolveRunTerminal(run),
      observeCompletion: async (handle, options) => {
        const observation = await observer.observeCompletion(handle, options)
        if (options.run && observation.error === AGENT_HOOKS_REVIEW_BLOCKED_ERROR) {
          const markDispatchResult = service.markDispatchResult.bind(service)
          void closeEarlierHookReviewRunTerminals(
            { store, runtime, markDispatchResult },
            options.run
          ).catch((error: unknown) => {
            console.warn('[automations] hook-review tab cleanup failed:', error)
          })
        }
        return observation
      }
    },
    onAutomationsChanged: (payload) => runtime.notifyAutomationsChanged(payload),
    allowRemoteHostScheduling: input.headless,
    headlessDispatcher: input.headless
      ? async (request) => {
          const { terminalHandle, ...launch } = await launchHeadlessAutomationAgent(runtime, {
            ...request,
            runs: store.listAutomationRuns(request.automation.id)
          })
          if (launch.terminalPaneKey) {
            launchedHandles.set(launch.terminalPaneKey, terminalHandle)
            if (launchedHandles.size > MAX_REMEMBERED_LAUNCHES) {
              launchedHandles.delete(launchedHandles.keys().next().value ?? '')
            }
          }
          // Let the watcher retry wait timeouts until completion or its observation deadline.
          return launch
        }
      : undefined
  })
  runtime.setAutomationService(service)
  if (input.headless) {
    bindHeadlessRunTerminalRetention(service, store, runtime)
  }
  return service
}

function bindHeadlessRunTerminalRetention(
  service: AutomationService,
  store: Store,
  runtime: OrcaRuntimeService
): void {
  const retention = createHeadlessRunTerminalRetention({
    listRuns: () => store.listAutomationRuns(),
    terminalClientUse: (run) =>
      run.terminalPtyId ? runtime.readTerminalClientUse(run.terminalPtyId) : 'unknown',
    runTerminalAlive: (run) => runOwnHandle(runtime, run) !== null,
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
    runOwnsWorkspace: (run) =>
      run.workspaceId !== null &&
      store.getWorktreeMeta(run.workspaceId)?.automationProvenance?.automationRunId === run.id,
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
    forgetRunTerminal: async (run) => {
      // An idle shell proves a dispatched run exited without a completion result.
      const unfinished = run.status === 'dispatched'
      await service.markDispatchResult({
        runId: run.id,
        status: unfinished ? 'dispatch_failed' : run.status,
        error: unfinished
          ? (run.error ?? 'The agent exited without reporting completion.')
          : run.error,
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

function automationAgentCommands(agentId: string | undefined): string[] {
  if (!isTuiAgent(agentId)) {
    return []
  }
  const config = TUI_AGENT_CONFIG[agentId]
  return [...getTuiAgentDetectCommands(config), config.launchCmd]
}
