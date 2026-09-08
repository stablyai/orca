import { useMemo } from 'react'
import MobileTasksScreen from '../../../app/h/[hostId]/tasks'
import { useMobileWebNativeShell } from '../../../../src/mobile-web/src/native-shell-channel'
import { nativeHostTaskDetailOperations } from '../../../src/tasks/native-host-task-detail-operations'
import { nativeHostTaskItemFileOperations } from '../../../src/tasks/native-host-task-item-file-operations'
import { nativeHostTaskItemMutationOperations } from '../../../src/tasks/native-host-task-item-mutation-operations'
import { nativeHostTaskItemReviewOperations } from '../../../src/tasks/native-host-task-item-review-operations'
import { nativeHostTaskLinearOperations } from '../../../src/tasks/native-host-task-linear-operations'
import { nativeHostTaskListOperations } from '../../../src/tasks/native-host-task-list-operations'
import { nativeHostTaskPreferenceOperations } from '../../../src/tasks/native-host-task-preference-operations'
import { nativeHostTaskProjectFileOperations } from '../../../src/tasks/native-host-task-project-file-operations'
import { nativeHostTaskProjectMutationOperations } from '../../../src/tasks/native-host-task-project-mutation-operations'
import { nativeHostTaskProviderWriteOperations } from '../../../src/tasks/native-host-task-provider-write-operations'
import { nativeHostTaskReadOperations } from '../../../src/tasks/native-host-task-read-operations'
import { webHostTaskDeviceOperations } from '../../../src/tasks/web-host-task-device-operations'
import { webHostTaskProjectReadOperations } from '../../../src/tasks/web-host-task-project-read-operations'
import { webHostWorkspaceCreationOperations } from '../../../src/worktree/web-host-workspace-creation-operations'

const HOSTED_PAGE_HOST_ID = 'paired-orca-desktop'

export default function HostMobileWebTasksRoute() {
  const shell = useMobileWebNativeShell()
  const operations = useMemo(() => {
    if (!shell.client) {
      return null
    }
    const sender = shell.client.hostRpcSender
    return {
      detail: nativeHostTaskDetailOperations(sender),
      device: webHostTaskDeviceOperations(shell.client),
      itemFile: nativeHostTaskItemFileOperations(sender),
      itemMutation: nativeHostTaskItemMutationOperations(sender),
      itemReview: nativeHostTaskItemReviewOperations(sender),
      linear: nativeHostTaskLinearOperations(sender),
      list: nativeHostTaskListOperations(sender),
      preference: nativeHostTaskPreferenceOperations(sender),
      projectFile: nativeHostTaskProjectFileOperations(sender),
      projectMutation: nativeHostTaskProjectMutationOperations(sender),
      projectRead: webHostTaskProjectReadOperations(sender),
      providerWrite: nativeHostTaskProviderWriteOperations(sender),
      read: nativeHostTaskReadOperations(sender),
      workspaceCreation: webHostWorkspaceCreationOperations(shell.client)
    }
  }, [shell.client])

  return (
    <MobileTasksScreen
      hostId={HOSTED_PAGE_HOST_ID}
      detailOperations={operations?.detail}
      deviceOperations={operations?.device}
      itemFileOperations={operations?.itemFile}
      itemMutationOperations={operations?.itemMutation}
      itemReviewOperations={operations?.itemReview}
      linearOperations={operations?.linear}
      listOperations={operations?.list}
      preferenceOperations={operations?.preference}
      projectFileOperations={operations?.projectFile}
      projectMutationOperations={operations?.projectMutation}
      projectReadOperations={operations?.projectRead}
      providerWriteOperations={operations?.providerWrite}
      readOperations={operations?.read}
      workspaceCreationOperations={operations?.workspaceCreation}
      connectionState={shell.connection}
      connectionMetrics={{
        reconnectAttempts: shell.reconnectAttempts,
        lastConnectedAt: shell.lastConnectedAt
      }}
      nativeHostBinding={false}
    />
  )
}
