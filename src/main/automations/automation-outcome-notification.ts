import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AutomationsChangedPayload } from '../../shared/runtime-client-events'
import { buildNotificationOptions } from '../ipc/notification-options'
import { getRuntimeDesktopSurface } from '../runtime/runtime-desktop-surface'
import { notificationExecutionHostForOwner } from '../../shared/notification-source'
import type { AutomationRunOutcome } from '../../shared/automation-run-outcome'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import type { ExecutionHostId } from '../../shared/execution-host'

export function automationOutcomeNotification(
  outcome: AutomationRunOutcome,
  context: {
    hostId?: ExecutionHostId
    notificationSourceId?: ExecutionHostId
    pairingRevision?: number
  } = {}
): NotificationDispatchRequest | null {
  const { run } = outcome
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
  payload: AutomationsChangedPayload
): void {
  const request = payload.settledRun ? automationOutcomeNotification(payload.settledRun) : null
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
      ...(request.worktreeId ? { worktreeId: request.worktreeId } : {}),
      ...(!(settings.enabled && settings.agentTaskComplete) ? { desktopAllowed: false } : {})
    })
  }
  runtime.notifyAutomationsChanged({
    ...payload,
    ...(request && payload.settledRun
      ? { settledRun: { ...payload.settledRun, mobileDeliveredByHost: true } }
      : {})
  })
}
