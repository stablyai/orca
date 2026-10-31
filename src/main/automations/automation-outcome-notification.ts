import {
  readAutomationRunPresentation,
  type AutomationRunOutcomeInput
} from '../../shared/automation-run-outcome'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import type { AutomationAttentionDelivery } from '../runtime/automation-attention-correlations'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AutomationsChangedPayload } from '../../shared/runtime-client-events'
import { buildNotificationOptions } from '../ipc/notification-options'
import { getRuntimeDesktopSurface } from '../runtime/runtime-desktop-surface'
import { notificationExecutionHostForOwner } from '../../shared/notification-source'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import type { ExecutionHostId } from '../../shared/execution-host'

export function automationOutcomeNotification(
  outcome: AutomationRunOutcomeInput,
  context: {
    hostId?: ExecutionHostId
    notificationSourceId?: ExecutionHostId
    pairingRevision?: number
  } = {}
): NotificationDispatchRequest | null {
  const { run } = outcome
  const presentation = readAutomationRunPresentation(outcome)
  // STA-10142 supplies Terminal turn attribution before its outcome banner is enabled.
  if (
    run.sessionKind === 'terminal' &&
    (run.status !== 'dispatch_failed' ||
      run.dispatchedAt !== null ||
      run.terminalPaneKey ||
      run.terminalPtyId)
  ) {
    return null
  }
  const executionHost = notificationExecutionHostForOwner({
    executionHostId: context.hostId ?? null,
    runtimeEnvironmentId: null
  })
  const key = JSON.stringify([
    'automation',
    context.hostId ?? 'local',
    context.pairingRevision ?? null,
    run.id,
    run.createdAt
  ])
  return {
    source: 'agent-task-complete',
    automationPresentation: presentation,
    ...(presentation.assistantMessage
      ? { agentLastAssistantMessage: presentation.assistantMessage }
      : {}),
    ...(presentation.origin ? { structuredOrigin: presentation.origin } : {}),
    ...(run.sessionKind === 'chat' && run.chatSessionId
      ? {
          paneKey: structuredAgentSessionPaneKey(
            structuredAgentSessionTabId(run.chatSessionId),
            run.chatSessionId
          )
        }
      : {}),
    notificationId: key,
    attentionKey: key,
    automationRun: {
      automationId: run.automationId,
      runId: run.id,
      ...(context.hostId ? { hostId: context.hostId } : {}),
      ...(context.pairingRevision !== undefined ? { pairingRevision: context.pairingRevision } : {})
    },
    ...(run.workspaceId ? { worktreeId: run.workspaceId } : {}),
    ...(context.notificationSourceId ? { notificationSourceId: context.notificationSourceId } : {}),
    ...(executionHost ? { executionHost } : {}),
    mobileDeliveredByHost: outcome.mobileDeliveredByHost,
    worktreeLabel: outcome.name,
    agentType: outcome.agentId,
    agentState: 'done',
    agentTurnOutcome: run.status === 'completed' ? 'success' : 'failure'
  }
}

export function publishAutomationOutcome(
  runtime: OrcaRuntimeService,
  store: Store,
  payload: AutomationsChangedPayload,
  attention?: AutomationAttentionDelivery
): void {
  const request =
    !attention?.covered() && payload.settledRun
      ? automationOutcomeNotification(payload.settledRun)
      : null
  if (request) {
    const settings = store.getSettings().notifications
    const options = buildNotificationOptions(
      request,
      getRuntimeDesktopSurface().translateNotification
    )
    runtime.dispatchMobileNotification({
      type: 'notification',
      emittedAt: Date.now(),
      source: request.source,
      title: options.title,
      body: options.body,
      agentState: 'done',
      notificationId: request.notificationId,
      attentionKey: request.attentionKey,
      ...(request.paneKey ? { paneKey: request.paneKey } : {}),
      ...(request.structuredOrigin ? { structuredOrigin: request.structuredOrigin } : {}),
      ...(request.worktreeId ? { worktreeId: request.worktreeId } : {}),
      ...(!(settings.enabled && settings.agentTaskComplete) ? { desktopAllowed: false } : {})
    })
  }
  const { settledRun, ...change } = payload
  runtime.notifyAutomationsChanged({
    ...change,
    ...(!attention?.covered() && settledRun ? { settledRun } : {}),
    ...(!attention?.covered() && request && payload.settledRun
      ? { settledRun: { ...payload.settledRun, mobileDeliveredByHost: true } }
      : {})
  })
}
