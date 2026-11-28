import type { AutomationUsageClient } from '../../shared/backend/backend-service-contract'
import { readAutomationRunReceipt } from './launch/automation-run-receipt'
import { tuiAgentDisplayName } from '../../shared/agent-launch/catalog/tui-agent-display-names'
import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { AutomationService } from './automation-service'
import { createRuntimeRunTerminalRetention } from './terminal-retention/runtime-run-terminal-retention'
import {
  getTuiAgentDetectCommands,
  isTuiAgent,
  TUI_AGENT_CONFIG
} from '../../shared/agent-launch/catalog/tui-agent-config'
import {
  AGENT_HOOKS_REVIEW_BLOCKED_ERROR,
  createRuntimeAutomationRunTerminalObserver
} from './observation/runtime-terminal-run-observer'
import { bindBotAutomations, botAutomationServiceOptions } from './bot-automation-service-wiring'
import { automationSystemSettled } from './dispatch/automation-wake-settle'

const MAX_REMEMBERED_LAUNCHES = 256

export function createRuntimeAutomationService(input: {
  store: Store
  runtime: OrcaRuntimeService
  claudeUsage?: AutomationUsageClient
  codexUsage?: AutomationUsageClient
  /** Only server processes execute remote_host_service schedules. */
  allowRemoteHostScheduling: boolean
  isHostQuitting?: () => boolean
}): AutomationService {
  const { store, runtime, claudeUsage, codexUsage } = input
  // Launch handles remain usable before pane-key lookup resolves.
  const launchedHandles = new Map<string, string>()
  const observer = createRuntimeAutomationRunTerminalObserver(runtime, {
    getAgentStatusRowsForPane: (paneKey) => runtime.getAgentStatusRowsForPane(paneKey),
    getAcceptedReply: (paneKey, leadTurnKey) => runtime.getAcceptedAgentReply(paneKey, leadTurnKey),
    subscribeStatusChanges: (listener) => runtime.subscribeAgentStatusRowChanges(listener),
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
      resolveRunTerminal: (run) => {
        if (run.sessionKind === 'chat') {
          return `automation:${run.id}`
        }
        if (run.status === 'dispatching') {
          const records = runtime.openedAgentSessionRecordStore()
          if (
            (records && readAutomationRunReceipt(records, run)) ||
            store.listAutomations().find((entry) => entry.id === run.automationId)?.surface ===
              'chat'
          ) {
            return `automation:${run.id}`
          }
          if (!records) {
            void runtime.openAgentSessionRecordStore().catch((error: unknown) => {
              console.warn('[automations] could not read accepted Chat operation:', error)
            })
          }
          // An unconfirmed terminal prompt is never resumed after restart; the run strands.
          return null
        }
        return (
          (run.terminalPaneKey ? launchedHandles.get(run.terminalPaneKey) : undefined) ??
          observer.resolveRunTerminal(run)
        )
      },
      observeCompletion: async (handle, options) => {
        let run = options.run
        if (run && handle.startsWith('automation:')) {
          if (!run.chatSessionId) {
            const records = await runtime.openAgentSessionRecordStore()
            const receipt = readAutomationRunReceipt(records, run)
            const agent =
              tuiAgentDisplayName(
                store.listAutomations().find((entry) => entry.id === run?.automationId)?.agentId ??
                  'Agent'
              ) ?? 'Agent'
            if (!receipt) {
              return {
                status: 'dispatch_failed',
                error: `${agent} could not confirm this run after Orca restarted. Open its workspace before running again.`
              }
            }
            const target =
              receipt.kind === 'terminal'
                ? (await import('./launch/automation-agent-run-result')).publishedLaunchTarget(
                    runtime,
                    receipt.launch
                  )
                : {
                    workspaceId: receipt.workspaceId,
                    sessionKind: 'chat' as const,
                    chatSessionId: receipt.sessionId,
                    terminalPaneKey: null,
                    terminalSessionId: null,
                    terminalPtyId: null
                  }
            run = await service.markDispatchResult({
              ...target,
              runId: run.id,
              status: receipt.accepted ? 'dispatched' : 'dispatch_failed',
              error: receipt.accepted
                ? null
                : `${agent} could not confirm this run's prompt. Open the run before trying again.`
            })
            if (!receipt.accepted) {
              return { status: 'dispatch_failed', error: run.error }
            }
            if (receipt.kind === 'terminal') {
              handle = receipt.launch.outcome.handle
            }
          }
          if (run.sessionKind === 'chat') {
            try {
              // A bot automation sends its own prompt; any other chat run is launched with a receipt.
              const sentByRun = Boolean(
                store.listAutomations().find((entry) => entry.id === run?.automationId)?.bot
              )
              const { observeAutomationChatRun } =
                await import('./observation/runtime-chat-run-observer')
              return await observeAutomationChatRun(runtime, run, options.signal, sentByRun)
            } catch (error) {
              if (options.signal.aborted) {
                throw error
              }
              console.error('[automations] chat run observation failed:', error)
              const agent =
                tuiAgentDisplayName(
                  store.listAutomations().find((entry) => entry.id === run?.automationId)
                    ?.agentId ?? 'Agent'
                ) ?? 'Agent'
              return {
                status: 'dispatch_failed',
                error: `${agent} stopped reporting this run's result. Open the chat before running again.`
              }
            }
          }
        }
        const observation = await observer.observeCompletion(handle, { ...options, run })
        if (options.run && observation.error === AGENT_HOOKS_REVIEW_BLOCKED_ERROR) {
          const markDispatchResult = service.markDispatchResult.bind(service)
          const blockedRun = options.run
          void import('./terminal-retention/hook-review-blocked-run-terminals')
            .then(({ closeEarlierHookReviewRunTerminals }) =>
              closeEarlierHookReviewRunTerminals({ store, runtime, markDispatchResult }, blockedRun)
            )
            .catch((error: unknown) => {
              console.warn('[automations] hook-review tab cleanup failed:', error)
            })
        }
        return observation
      }
    },
    isHostQuitting: input.isHostQuitting,
    onAutomationsChanged: (payload) => runtime.notifyAutomationsChanged(payload),
    allowRemoteHostScheduling: input.allowRemoteHostScheduling,
    ...botAutomationServiceOptions(runtime),
    chatDispatcher: async (request) => {
      const [{ launchAutomationChatAgent }, { automationRunSetupSkip }] = await Promise.all([
        import('./launch/automation-chat-agent-launch'),
        import('./launch/automation-run-setup-skip')
      ])
      const { terminalHandle, ...launched } = await launchAutomationChatAgent(runtime, {
        ...request,
        runs: store.listAutomationRuns(request.automation.id)
      })
      const launch = {
        ...launched,
        ...(await automationRunSetupSkip(
          runtime,
          request.automation,
          request.target.repo,
          launched.workspaceId
        ))
      }
      if (launch.terminalPaneKey && terminalHandle) {
        launchedHandles.set(launch.terminalPaneKey, terminalHandle)
        if (launchedHandles.size > MAX_REMEMBERED_LAUNCHES) {
          launchedHandles.delete(launchedHandles.keys().next().value ?? '')
        }
      }
      return launch
    },
    terminalLauncher: {
      launch: async (request) => {
        const [{ launchAutomationTerminalAgent }, { automationRunSetupSkip }] = await Promise.all([
          import('./launch/automation-terminal-launch'),
          import('./launch/automation-run-setup-skip')
        ])
        const { terminalHandle, ...launched } = await launchAutomationTerminalAgent(runtime, {
          ...request,
          runs: store.listAutomationRuns(request.automation.id)
        })
        const launch = {
          ...launched,
          ...(await automationRunSetupSkip(
            runtime,
            request.automation,
            request.target.repo,
            launched.workspaceId
          ))
        }
        if (launch.terminalPaneKey) {
          launchedHandles.set(launch.terminalPaneKey, terminalHandle)
          if (launchedHandles.size > MAX_REMEMBERED_LAUNCHES) {
            launchedHandles.delete(launchedHandles.keys().next().value ?? '')
          }
        }
        // Let the watcher retry wait timeouts until completion or its observation deadline.
        return launch
      },
      available: () => runtime.canOpenRunTerminals()
    },
    runTerminalRetention: (owner) => createRuntimeRunTerminalRetention(owner, store, runtime)
  })
  service.wakeGate.settled = () => automationSystemSettled()
  runtime.setAutomationService(service)
  bindBotAutomations(service, store, runtime)
  return service
}

function automationAgentCommands(agentId: string | undefined): string[] {
  if (!isTuiAgent(agentId)) {
    return []
  }
  const config = TUI_AGENT_CONFIG[agentId]
  return [...getTuiAgentDetectCommands(config), config.launchCmd]
}
