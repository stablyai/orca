import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { publishAutomationOutcome } from './automation-outcome-notification'
import { observeAutomationChatRun } from './runtime-chat-run-observer'
import { readAutomationRunReceipt } from './automation-run-receipt'
import { publishedLaunchTarget } from './automation-agent-run-result'
import { launchAutomationChatAgent } from './automation-chat-agent-launch'
import { tuiAgentDisplayName } from '../../shared/tui-agent-display-names'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { AutomationService } from './service'
import { bindHeadlessRunTerminalRetention } from './headless-run-terminal-retention'
import { launchHeadlessAutomationAgent } from './headless-automation-agent-launch'
import {
  automationAgentCommands,
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
  const attention = runtime.createAutomationAttentionOwner()
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
    attention,
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
                ? publishedLaunchTarget(runtime, receipt.launch)
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
              return await observeAutomationChatRun(
                runtime,
                run,
                options.signal,
                attention.admit(run.id)
              )
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
    onAutomationsChanged: (payload, delivery) =>
      publishAutomationOutcome(runtime, store, payload, delivery),
    allowRemoteHostScheduling: input.headless,
    chatDispatcher: async (request) => {
      attention.admit(request.run.id)
      let accepted = false
      try {
        const { terminalHandle, ...launch } = await launchAutomationChatAgent(runtime, {
          ...request,
          runs: store.listAutomationRuns(request.automation.id)
        })
        if (launch.terminalPaneKey && terminalHandle) {
          launchedHandles.set(launch.terminalPaneKey, terminalHandle)
          if (launchedHandles.size > MAX_REMEMBERED_LAUNCHES) {
            launchedHandles.delete(launchedHandles.keys().next().value ?? '')
          }
        }
        accepted = launch.sessionKind === 'chat'
        return launch
      } finally {
        if (!accepted) {
          getStructuredAgentSessionHost()?.settleAutomationChatRun(request.run.id)
        }
      }
    },
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
  let ownedHost: ReturnType<typeof getStructuredAgentSessionHost> = null
  const releaseRemovals = store.observeAutomationRunRemovals((id) => {
    attention.release(id)
    ownedHost?.automationChatInterests.forget(id)
  })
  service.attachChatOwnership = (host, records) => {
    if (ownedHost === host) {
      return
    }
    ownedHost?.automationChatInterests.clear()
    ownedHost = host
    host.automationChatInterests.connectAttention(attention.get)
    for (const run of store.listAutomationRuns()) {
      const receipt = readAutomationRunReceipt(records, run)
      if (receipt?.kind === 'chat' && receipt.accepted && receipt.messageId) {
        host.registerAutomationChatRun(run.id, receipt.sessionId, receipt.messageId)
      }
    }
    host.reconcileAutomationChatOwnership()
  }
  const stop = service.stop.bind(service)
  service.stop = () => {
    releaseRemovals()
    attention.dispose()
    ownedHost?.automationChatInterests.clear()
    ownedHost = null
    service.attachChatOwnership = null
    stop()
  }
  runtime.setAutomationService(service)
  if (input.headless) {
    bindHeadlessRunTerminalRetention(service, store, runtime)
  }
  return service
}
