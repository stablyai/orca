/**
 * The AutomationService a runtime host executes schedules with. Shared by Electron startup and
 * orcad so both hosts dispatch through the same headless path.
 */
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { AutomationService } from './service'
import type { AutomationRun } from '../../shared/automations-types'
import { createHeadlessRunTerminalRetention } from './headless-run-terminal-retention'
import {
  getTuiAgentDetectCommands,
  isTuiAgent,
  TUI_AGENT_CONFIG
} from '../../shared/tui-agent-config'
import { launchHeadlessAutomationAgent } from './headless-automation-agent-launch'
import { createRuntimeAutomationRunTerminalObserver } from './runtime-terminal-run-observer'

const MAX_REMEMBERED_LAUNCHES = 256

export function createRuntimeAutomationService(input: {
  store: Store
  runtime: OrcaRuntimeService
  claudeUsage?: ClaudeUsageStore
  codexUsage?: CodexUsageStore
  /** A server process: it executes remote_host_service-owned schedules and dispatches headlessly. */
  headless: boolean
}): AutomationService {
  const { store, runtime, claudeUsage, codexUsage } = input
  // The handle each headless launch returned, so its watcher never depends on a pane-key lookup.
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
      // This host's own launch handle first: it names the run's terminal without a lookup.
      resolveRunTerminal: (run) =>
        (run.terminalPaneKey ? launchedHandles.get(run.terminalPaneKey) : undefined) ??
        observer.resolveRunTerminal(run)
    },
    onAutomationsChanged: (payload) => runtime.notifyAutomationsChanged(payload),
    allowRemoteHostScheduling: input.headless,
    headlessDispatcher: input.headless
      ? async (request) => {
          const { terminalHandle, ...launch } = await launchHeadlessAutomationAgent(
            runtime,
            request
          )
          if (launch.terminalPaneKey) {
            launchedHandles.set(launch.terminalPaneKey, terminalHandle)
            if (launchedHandles.size > MAX_REMEMBERED_LAUNCHES) {
              launchedHandles.delete(launchedHandles.keys().next().value ?? '')
            }
          }
          // No completion: the run's watcher observes it, retrying wait timeouts until it settles.
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

/** A headless host has no renderer to close finished run terminals; its service does it. */
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
      // Only the run's own process: a restarted pane holds a new PTY a user may be working in.
      const handle = runOwnHandle(runtime, run)
      if (!handle) {
        return false
      }
      // The run's pane only: a pane a user split into the same tab is theirs.
      await runtime.closeTerminal(handle)
      return true
    },
    forgetRunTerminal: async (run) => {
      // A run still dispatched had its agent exit without a result, proven by its idle shell.
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

/** The run's pane handle while that pane still holds the run's own PTY; null otherwise. */
function runOwnHandle(runtime: OrcaRuntimeService, run: AutomationRun): string | null {
  const handle = run.terminalPaneKey
    ? runtime.getTerminalHandleForPaneKey(run.terminalPaneKey)
    : null
  return handle &&
    run.terminalPtyId &&
    runtime.getTerminalPtyIdForHandle(handle) === run.terminalPtyId
    ? handle
    : null
}
