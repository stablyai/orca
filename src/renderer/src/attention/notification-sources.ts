import { notificationSourceForOwner } from '../../../shared/notifications/notification-source'
import { buildExecutionHostRegistry } from '../../../shared/execution-host/execution-host-registry'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host/execution-host-registry-entry'
import { getHostDisplayLabelOverrides } from '../../../shared/execution-host/host-setting-overrides'
import type { AppState } from '@/store/types'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'

export type NotificationSourceCatalog = Pick<
  AppState,
  'sshTargetLabels' | 'sshConnectionStates' | 'settings' | 'runtimeEnvironments'
> & { runtimeStatusByEnvironmentId: RuntimeStatuses }

export function buildNotificationSourceOptions(
  state: NotificationSourceCatalog
): ExecutionHostRegistryEntry[] {
  const runtimeEnvironments = state.runtimeEnvironments
  const configuredEnvironments = new Set(runtimeEnvironments.map((environment) => environment.id))
  return buildExecutionHostRegistry({
    repos: [],
    settings: null,
    hostSource: 'configured-only',
    sshTargetLabels: state.sshTargetLabels,
    sshConnectionStates: state.sshConnectionStates,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId: new Map(
      [...state.runtimeStatusByEnvironmentId].filter(([id]) => configuredEnvironments.has(id))
    ),
    hostLabelOverrides: getHostDisplayLabelOverrides(state.settings)
  }).filter(
    (entry) =>
      notificationSourceForOwner(
        {
          executionHostId: entry.id,
          runtimeEnvironmentId: null
        },
        state
      ) === entry.id
  )
}
