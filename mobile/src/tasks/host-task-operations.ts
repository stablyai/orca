import type { HostTaskDetailOperations } from './host-task-detail-operations'
import type { HostTaskItemFileOperations } from './host-task-item-file-operations'
import type { HostTaskItemMutationOperations } from './host-task-item-mutation-operations'
import type { HostTaskItemReviewOperations } from './host-task-item-review-operations'
import type { HostTaskLinearOperations } from './host-task-linear-operations'
import type { HostTaskListOperations } from './host-task-list-operations'
import type { HostTaskPreferenceOperations } from './host-task-preference-operations'
import type { HostTaskProjectFileOperations } from './host-task-project-file-operations'
import type { HostTaskProjectMutationOperations } from './host-task-project-mutation-operations'
import type { HostTaskProjectReadOperations } from './host-task-project-read-operations'
import type { HostTaskProviderWriteOperations } from './host-task-provider-write-operations'
import type { HostTaskReadOperations } from './host-task-read-operations'

/** Everything the task screens ask a host for, grouped by concern so a screen takes one prop and
 *  a provider is built once. Each namespace keeps its own contract file. */
export type HostTaskOperations = {
  read: HostTaskReadOperations
  preference: HostTaskPreferenceOperations
  list: HostTaskListOperations
  detail: HostTaskDetailOperations
  itemMutation: HostTaskItemMutationOperations
  itemReview: HostTaskItemReviewOperations
  itemFile: HostTaskItemFileOperations
  linear: HostTaskLinearOperations
  providerWrite: HostTaskProviderWriteOperations
  projectRead: HostTaskProjectReadOperations
  projectMutation: HostTaskProjectMutationOperations
  projectFile: HostTaskProjectFileOperations
}
