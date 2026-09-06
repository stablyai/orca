import type { MobileTasksScreenProps } from './mobile-tasks-screen-props'
import { useMobileWebRouteParams } from '../mobile-web/use-mobile-web-route-params'
import { useHostClient } from '../transport/client-context'
import {
  useLastConnectedAt,
  useReconnectAttempt,
  useRelayRecoveryStatus
} from '../transport/client-context-connection-metrics'
import { defaultHostWorkspaceCreationOperations } from '../worktree/default-host-workspace-creation-operations'
import { defaultHostTaskDetailOperations } from './default-host-task-detail-operations'
import { defaultHostTaskDeviceOperations } from './default-host-task-device-operations'
import { defaultHostTaskItemFileOperations } from './default-host-task-item-file-operations'
import { defaultHostTaskItemMutationOperations } from './default-host-task-item-mutation-operations'
import { defaultHostTaskItemReviewOperations } from './default-host-task-item-review-operations'
import { defaultHostTaskLinearOperations } from './default-host-task-linear-operations'
import { defaultHostTaskListOperations } from './default-host-task-list-operations'
import { defaultHostTaskPreferenceOperations } from './default-host-task-preference-operations'
import { defaultHostTaskProjectFileOperations } from './default-host-task-project-file-operations'
import { defaultHostTaskProjectMutationOperations } from './default-host-task-project-mutation-operations'
import { defaultHostTaskProjectReadOperations } from './default-host-task-project-read-operations'
import { defaultHostTaskProviderWriteOperations } from './default-host-task-provider-write-operations'
import { defaultHostTaskReadOperations } from './default-host-task-read-operations'
import {
  type HostTaskListOperations,
  useCallback,
  useMemo,
  useRef,
  useRouter,
  useSafeAreaInsets
} from './mobile-tasks-dependencies'

export function useMobileTasksHostOperations({
  hostId: hostIdProp,
  detailOperations,
  deviceOperations = defaultHostTaskDeviceOperations(),
  itemMutationOperations,
  itemReviewOperations,
  itemFileOperations,
  linearOperations,
  providerWriteOperations,
  listOperations,
  preferenceOperations,
  projectFileOperations,
  projectMutationOperations,
  projectReadOperations,
  readOperations,
  workspaceCreationOperations,
  connectionState,
  connectionMetrics,
  nativeHostBinding = true
}: MobileTasksScreenProps) {
  const params = useMobileWebRouteParams<{ hostId: string; taskSource?: string }>()
  const hostId = hostIdProp ?? params.hostId
  const taskSource = params.taskSource
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const nativeHost = useHostClient(nativeHostBinding ? hostId : undefined)
  const client = nativeHost.client
  const connState = connectionState ?? nativeHost.state
  const handleOpenExternalUrl = useCallback(
    (url: string) => {
      void deviceOperations?.openExternalUrl(url).catch(() => {})
    },
    [deviceOperations]
  )
  const taskReadOperations = useMemo(
    () => readOperations ?? (client ? defaultHostTaskReadOperations(client) : null),
    [client, readOperations]
  )
  const taskPreferenceOperations = useMemo(
    () => preferenceOperations ?? (client ? defaultHostTaskPreferenceOperations(client) : null),
    [client, preferenceOperations]
  )
  const taskListOperations = useMemo(
    () => listOperations ?? (client ? defaultHostTaskListOperations(client) : null),
    [client, listOperations]
  )
  const taskDetailOperations = useMemo(
    () => detailOperations ?? (client ? defaultHostTaskDetailOperations(client) : null),
    [client, detailOperations]
  )
  const taskItemMutationOperations = useMemo(
    () => itemMutationOperations ?? (client ? defaultHostTaskItemMutationOperations(client) : null),
    [client, itemMutationOperations]
  )
  const taskItemReviewOperations = useMemo(
    () => itemReviewOperations ?? (client ? defaultHostTaskItemReviewOperations(client) : null),
    [client, itemReviewOperations]
  )
  const taskItemFileOperations = useMemo(
    () => itemFileOperations ?? (client ? defaultHostTaskItemFileOperations(client) : null),
    [client, itemFileOperations]
  )
  const taskLinearOperations = useMemo(
    () => linearOperations ?? (client ? defaultHostTaskLinearOperations(client) : null),
    [client, linearOperations]
  )
  const taskProviderWriteOperations = useMemo(
    () =>
      providerWriteOperations ?? (client ? defaultHostTaskProviderWriteOperations(client) : null),
    [client, providerWriteOperations]
  )
  const taskProjectReadOperations = useMemo(
    () => projectReadOperations ?? (client ? defaultHostTaskProjectReadOperations(client) : null),
    [client, projectReadOperations]
  )
  const taskProjectMutationOperations = useMemo(
    () =>
      projectMutationOperations ??
      (client ? defaultHostTaskProjectMutationOperations(client) : null),
    [client, projectMutationOperations]
  )
  const taskProjectFileOperations = useMemo(
    () => projectFileOperations ?? (client ? defaultHostTaskProjectFileOperations(client) : null),
    [client, projectFileOperations]
  )
  const taskWorkspaceCreationOperations = useMemo(
    () =>
      workspaceCreationOperations ??
      (client ? defaultHostWorkspaceCreationOperations(client) : null),
    [client, workspaceCreationOperations]
  )
  const nativeReconnectAttempts = useReconnectAttempt(hostId)
  const nativeLastConnectedAt = useLastConnectedAt(hostId)
  const reconnectAttempts = connectionMetrics?.reconnectAttempts ?? nativeReconnectAttempts
  const lastConnectedAt = connectionMetrics?.lastConnectedAt ?? nativeLastConnectedAt
  const taskListOperationsRef = useRef<HostTaskListOperations | null>(null)
  const relayRecovery = useRelayRecoveryStatus(nativeHostBinding ? hostId : undefined)
  return {
    client,
    connState,
    deviceOperations,
    handleOpenExternalUrl,
    hostId,
    insets,
    lastConnectedAt,
    nativeHostBinding,
    nativeLastConnectedAt,
    nativeReconnectAttempts,
    reconnectAttempts,
    relayRecovery,
    router,
    taskDetailOperations,
    taskItemFileOperations,
    taskItemMutationOperations,
    taskItemReviewOperations,
    taskLinearOperations,
    taskListOperations,
    taskListOperationsRef,
    taskPreferenceOperations,
    taskProjectFileOperations,
    taskProjectMutationOperations,
    taskProjectReadOperations,
    taskProviderWriteOperations,
    taskReadOperations,
    taskSource,
    taskWorkspaceCreationOperations
  }
}

export type MobileTasksHostOperations = ReturnType<typeof useMobileTasksHostOperations>
