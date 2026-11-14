import { WorkspaceCleanupScanParams } from '../../../../../shared/rpc-contract/workspace-cleanup/workspace-cleanup-scan-params'
import { scanWorkspaceCleanup } from '../../../../ipc/workspace-cleanup/workspace-cleanup-scan'
import { defineMethod } from '../../core'

/** The same scan desktop IPC runs, over the repos this host owns; clients merge hosts themselves. */
export const WORKSPACE_CLEANUP_SCAN_METHOD = defineMethod({
  name: 'workspaceCleanup.scan',
  permission: 'workspace',
  params: WorkspaceCleanupScanParams,
  handler: (params, { runtime, signal }) =>
    scanWorkspaceCleanup(runtime.requireStore(), params, {
      signal,
      getOrchestrationDb: () => runtime.getExistingOrchestrationDb()
    })
})
