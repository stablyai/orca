import type {
  ConnectionState,
  HostTaskDetailOperations,
  HostTaskDeviceOperations,
  HostTaskItemFileOperations,
  HostTaskItemMutationOperations,
  HostTaskItemReviewOperations,
  HostTaskLinearOperations,
  HostTaskListOperations,
  HostTaskPreferenceOperations,
  HostTaskProjectFileOperations,
  HostTaskProjectMutationOperations,
  HostTaskProjectReadOperations,
  HostTaskProviderWriteOperations,
  HostTaskReadOperations,
  HostWorkspaceCreationOperations
} from './mobile-tasks-dependencies'

export type MobileTasksScreenProps = {
  hostId?: string
  detailOperations?: HostTaskDetailOperations
  deviceOperations?: HostTaskDeviceOperations
  itemMutationOperations?: HostTaskItemMutationOperations
  itemReviewOperations?: HostTaskItemReviewOperations
  itemFileOperations?: HostTaskItemFileOperations
  linearOperations?: HostTaskLinearOperations
  providerWriteOperations?: HostTaskProviderWriteOperations
  listOperations?: HostTaskListOperations
  preferenceOperations?: HostTaskPreferenceOperations
  projectFileOperations?: HostTaskProjectFileOperations
  projectMutationOperations?: HostTaskProjectMutationOperations
  projectReadOperations?: HostTaskProjectReadOperations
  readOperations?: HostTaskReadOperations
  workspaceCreationOperations?: HostWorkspaceCreationOperations
  connectionState?: ConnectionState
  connectionMetrics?: {
    reconnectAttempts: number
    lastConnectedAt: number | null
  }
  nativeHostBinding?: boolean
}
