import { useMemo } from 'react'
import MobileTasksScreen from '../../../app/h/[hostId]/tasks'
import { useMobileWebNativeShell } from '../../../../src/mobile-web/src/native-shell-channel'
import { webHostTaskDetailOperations } from '../../../src/tasks/web-host-task-detail-operations'
import { webHostTaskDeviceOperations } from '../../../src/tasks/web-host-task-device-operations'
import { webHostTaskItemFileOperations } from '../../../src/tasks/web-host-task-item-file-operations'
import { webHostTaskItemMutationOperations } from '../../../src/tasks/web-host-task-item-mutation-operations'
import { webHostTaskItemReviewOperations } from '../../../src/tasks/web-host-task-item-review-operations'
import { webHostTaskLinearOperations } from '../../../src/tasks/web-host-task-linear-operations'
import { webHostTaskListOperations } from '../../../src/tasks/web-host-task-list-operations'
import { webHostTaskPreferenceOperations } from '../../../src/tasks/web-host-task-preference-operations'
import { webHostTaskProjectFileOperations } from '../../../src/tasks/web-host-task-project-file-operations'
import { webHostTaskProjectMutationOperations } from '../../../src/tasks/web-host-task-project-mutation-operations'
import { webHostTaskProjectReadOperations } from '../../../src/tasks/web-host-task-project-read-operations'
import { webHostTaskProviderWriteOperations } from '../../../src/tasks/web-host-task-provider-write-operations'
import { webHostTaskReadOperations } from '../../../src/tasks/web-host-task-read-operations'
import { webHostWorkspaceCreationOperations } from '../../../src/worktree/web-host-workspace-creation-operations'

const HOSTED_PAGE_HOST_ID = 'paired-orca-desktop'

export default function HostMobileWebTasksRoute() {
  const shell = useMobileWebNativeShell()
  const operations = useMemo(() => {
    if (!shell.client) {
      return null
    }
    return {
      detail: webHostTaskDetailOperations(shell.client),
      device: webHostTaskDeviceOperations(shell.client),
      itemFile: webHostTaskItemFileOperations(shell.client),
      itemMutation: webHostTaskItemMutationOperations(shell.client),
      itemReview: webHostTaskItemReviewOperations(shell.client),
      linear: webHostTaskLinearOperations(shell.client),
      list: webHostTaskListOperations(shell.client),
      preference: webHostTaskPreferenceOperations(shell.client),
      projectFile: webHostTaskProjectFileOperations(shell.client),
      projectMutation: webHostTaskProjectMutationOperations(shell.client),
      projectRead: webHostTaskProjectReadOperations(shell.client),
      providerWrite: webHostTaskProviderWriteOperations(shell.client),
      read: webHostTaskReadOperations(shell.client),
      workspaceCreation: webHostWorkspaceCreationOperations(shell.client)
    }
  }, [shell.client])
  const connectionState =
    shell.connection === 'offline'
      ? 'disconnected'
      : shell.connection === 'recovering'
        ? 'reconnecting'
        : shell.connection

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
      connectionState={connectionState}
      connectionMetrics={{
        reconnectAttempts: shell.reconnectAttempts,
        lastConnectedAt: shell.lastConnectedAt
      }}
      nativeHostBinding={false}
    />
  )
}
