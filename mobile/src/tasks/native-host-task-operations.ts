import type { RpcClient } from '../transport/rpc-client'
import type { HostTaskOperations } from './host-task-operations'
import { nativeHostTaskDetailOperations } from './native-host-task-detail-operations'
import { nativeHostTaskItemFileOperations } from './native-host-task-item-file-operations'
import { nativeHostTaskItemMutationOperations } from './native-host-task-item-mutation-operations'
import { nativeHostTaskItemReviewOperations } from './native-host-task-item-review-operations'
import { nativeHostTaskLinearOperations } from './native-host-task-linear-operations'
import { nativeHostTaskListOperations } from './native-host-task-list-operations'
import { nativeHostTaskPreferenceOperations } from './native-host-task-preference-operations'
import { nativeHostTaskProjectFileOperations } from './native-host-task-project-file-operations'
import { nativeHostTaskProjectMutationOperations } from './native-host-task-project-mutation-operations'
import { nativeHostTaskProjectReadOperations } from './native-host-task-project-read-operations'
import { nativeHostTaskProviderWriteOperations } from './native-host-task-provider-write-operations'
import { nativeHostTaskReadOperations } from './native-host-task-read-operations'

export function nativeHostTaskOperations(client: RpcClient): HostTaskOperations {
  return {
    read: nativeHostTaskReadOperations(client),
    preference: nativeHostTaskPreferenceOperations(client),
    list: nativeHostTaskListOperations(client),
    detail: nativeHostTaskDetailOperations(client),
    itemMutation: nativeHostTaskItemMutationOperations(client),
    itemReview: nativeHostTaskItemReviewOperations(client),
    itemFile: nativeHostTaskItemFileOperations(client),
    linear: nativeHostTaskLinearOperations(client),
    providerWrite: nativeHostTaskProviderWriteOperations(client),
    projectRead: nativeHostTaskProjectReadOperations(client),
    projectMutation: nativeHostTaskProjectMutationOperations(client),
    projectFile: nativeHostTaskProjectFileOperations(client)
  }
}
