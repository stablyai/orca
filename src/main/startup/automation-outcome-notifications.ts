import { AUTOMATION_RUN_SEEN_CAPABILITY } from '../../shared/automation-runtime-capabilities'
import { isAutomationRunOutcome } from '../../shared/automation-run-outcome'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { isRuntimeSubscriptionReplayResponse } from '../../shared/runtime-subscription-replay'
import { notificationSourceForOwner } from '../../shared/notification-source'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../shared/execution-host'
import type { AutomationsChangedPayload } from '../../shared/runtime-client-events'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { automationOutcomeNotification } from '../automations/automation-outcome-notification'
import { dispatchRegisteredNotification } from '../ipc/notifications'
import {
  presentAppNotificationResult,
  closeAppNotificationPresentation
} from '../notifications/app-notification-presentation'
import { getRuntimeEnvironmentStatusSnapshots } from '../ipc/runtime-environments/runtime-environment-request-connections'
import { getRuntimeEnvironmentRegistryRoot } from '../ipc/runtime-environments/runtime-environment-registry-root'
import { getRuntimeEnvironmentTransportGeneration } from '../ipc/runtime-environments/runtime-environment-transport-generation'
import { onRuntimeEnvironmentStatusPublished } from '../ipc/runtime-environments/runtime-environment-status-owner'
import { subscribeRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'

export function startAutomationOutcomeNotifications(
  runtime: OrcaRuntimeService,
  store: Store
): () => void {
  let stopped = false
  const watches = new Map<string, { fence: string; close: () => void }>()
  const deliver = (
    payload: AutomationsChangedPayload,
    environmentId?: string,
    pairingRevision?: number
  ): void => {
    if (stopped || !payload.settledRun) {
      return
    }
    const hostId = environmentId
      ? toRuntimeExecutionHostId(environmentId)
      : payload.selector?.kind === 'ssh'
        ? toSshExecutionHostId(payload.selector.targetId)
        : undefined
    const request = automationOutcomeNotification(payload.settledRun, {
      ...(hostId ? { hostId } : {}),
      ...(pairingRevision !== undefined ? { pairingRevision } : {}),
      notificationSourceId: notificationSourceForOwner(
        { executionHostId: hostId ?? 'local', runtimeEnvironmentId: environmentId ?? null },
        {
          runtimeEnvironments: listEnvironments(getRuntimeEnvironmentRegistryRoot()),
          sshTargetLabels: new Map(store.getSshTargets().map((target) => [target.id, target.label]))
        }
      )
    })
    if (!request) {
      return
    }
    const session = store.getWorkspaceSession()
    const configured = store.getSettings()
    const activeHost =
      session.activeWorkspaceExecutionHostId ??
      (configured.activeRuntimeEnvironmentId
        ? toRuntimeExecutionHostId(configured.activeRuntimeEnvironmentId)
        : 'local')
    request.isActiveWorktree = Boolean(
      activeHost === (hostId ?? 'local') &&
      request.worktreeId &&
      session.activeWorktreeId === request.worktreeId &&
      store.getUI().activeView === 'terminal'
    )
    const settings = configured.notifications
    void Promise.resolve(dispatchRegisteredNotification(request))
      .then((result) => {
        if (!stopped) {
          return presentAppNotificationResult(result, settings)
        }
      })
      .catch((error) => console.warn('[automations] Could not present outcome:', error))
  }
  const stopLocal = runtime.onClientEvent(
    (event) => {
      if (event.type === 'automationsChanged') {
        deliver(event)
      }
    },
    { consumesTerminalSideEffects: false }
  )
  const refresh = (): void => {
    const snapshots = getRuntimeEnvironmentStatusSnapshots()
    const live = new Set<string>()
    for (const snapshot of snapshots) {
      if (
        snapshot.retired ||
        snapshot.verification !== 'verified' ||
        snapshot.transport !== 'ready' ||
        !snapshot.status?.capabilities?.includes(AUTOMATION_RUN_SEEN_CAPABILITY)
      ) {
        continue
      }
      const id = snapshot.environmentId
      live.add(id)
      const generation = getRuntimeEnvironmentTransportGeneration(id)
      const fence = JSON.stringify([
        snapshot.pairingRevision,
        snapshot.status.runtimeId,
        generation
      ])
      if (watches.get(id)?.fence === fence) {
        continue
      }
      watches.get(id)?.close()
      const controller = new AbortController()
      let subscription: { close: () => void } | undefined
      const watch = {
        fence,
        close: (): void => {
          if (controller.signal.aborted) {
            return
          }
          controller.abort()
          subscription?.close()
        }
      }
      watches.set(id, watch)
      const current = (): boolean =>
        !stopped &&
        !controller.signal.aborted &&
        watches.get(id) === watch &&
        getRuntimeEnvironmentTransportGeneration(id) === generation
      const end = (): void => {
        watch.close()
        if (watches.get(id) === watch) {
          watches.delete(id)
        }
      }
      void subscribeRuntimeEnvironment(
        getRuntimeEnvironmentRegistryRoot(),
        id,
        'runtime.clientEvents.subscribe',
        undefined,
        15_000,
        {
          onEvent: (payload) => {
            if (
              !current() ||
              payload.type !== 'response' ||
              !payload.response.ok ||
              isRuntimeSubscriptionReplayResponse(payload.response)
            ) {
              return
            }
            const value: unknown = payload.response.result
            if (
              value &&
              typeof value === 'object' &&
              'type' in value &&
              value.type === 'automationsChanged' &&
              'settledRun' in value &&
              isAutomationRunOutcome(value.settledRun)
            ) {
              deliver({ settledRun: value.settledRun }, id, snapshot.pairingRevision)
            }
          },
          onClose: end
        },
        current,
        controller.signal,
        { wslStart: 'never' }
      ).then((opened) => {
        subscription = opened
        if (!current()) {
          opened.close()
        }
      }, end)
    }
    for (const [id, watch] of watches) {
      if (!live.has(id)) {
        watch.close()
        watches.delete(id)
      }
    }
  }
  const stopStatus = onRuntimeEnvironmentStatusPublished(refresh)
  refresh()
  return () => {
    stopped = true
    stopLocal()
    stopStatus()
    for (const watch of watches.values()) {
      watch.close()
    }
    watches.clear()
    closeAppNotificationPresentation()
  }
}
