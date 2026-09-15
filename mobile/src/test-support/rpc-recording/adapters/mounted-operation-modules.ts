import { fileInventoryMountAdapters } from './file-inventory-mount-adapters'
import { hostedReviewMountAdapters } from './hosted-review-mount-adapters'
import { newTabAgentMountAdapters } from './new-tab-agent-mount-adapters'
import { settingsMountAdapters, settingsMountExposures } from './settings-mount-adapters'
import { sourceControlMountAdapters } from './source-control-mount-adapters'
import { taskMountAdapters } from './task-mount-adapters'
import { taskWorkspaceHookMountAdapters } from './task-workspace-hook-mount-adapters'
import { taskWorkspaceSenderMountAdapters } from './task-workspace-sender-mount-adapters'
import { workspaceSettingsMounts } from './workspace-settings-mounts'
import type { MountedOperationModule } from '../mounted-operation-module'

/**
 * Every domain's mount adapters, paired with the file each one lives in. The register lives inside
 * the seam it registers, so adding a domain edits no engine file and moves no existing golden;
 * `adapter-seam.test.ts` checks each pairing names the file that declares it.
 */
export const MOUNTED_OPERATION_MODULES: readonly MountedOperationModule[] = [
  { source: 'file-inventory-mount-adapters.ts', mounts: fileInventoryMountAdapters },
  { source: 'hosted-review-mount-adapters.ts', mounts: hostedReviewMountAdapters },
  { source: 'new-tab-agent-mount-adapters.ts', mounts: newTabAgentMountAdapters },
  {
    source: 'settings-mount-adapters.ts',
    mounts: settingsMountAdapters,
    exposes: settingsMountExposures
  },
  { source: 'source-control-mount-adapters.ts', mounts: sourceControlMountAdapters },
  { source: 'task-mount-adapters.ts', mounts: taskMountAdapters },
  {
    source: 'task-workspace-hook-mount-adapters.ts',
    mounts: taskWorkspaceHookMountAdapters
  },
  {
    source: 'task-workspace-sender-mount-adapters.ts',
    mounts: taskWorkspaceSenderMountAdapters
  },
  { source: 'workspace-settings-mounts.ts', mounts: workspaceSettingsMounts }
]
