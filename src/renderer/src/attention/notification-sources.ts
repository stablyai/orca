import { notificationSourceForOwner } from '../../../shared/notification-source'
import {
  buildExecutionHostRegistry,
  type ExecutionHostRegistryEntry
} from '../../../shared/execution-host-registry'
import { getHostDisplayLabelOverrides } from '../../../shared/host-setting-overrides'
import type { AppState } from '@/store/types'

export type NotificationSourceCatalog = Pick<
  AppState,
  | 'sshTargetLabels'
  | 'sshConnectionStates'
  | 'settings'
  | 'runtimeEnvironments'
  | 'runtimeStatusByEnvironmentId'
>

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
