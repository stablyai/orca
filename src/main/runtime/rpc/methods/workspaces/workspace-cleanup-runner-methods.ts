import {
  WorkspaceCleanupPreviewParams,
  WorkspaceCleanupReportUnsavedEditorsParams,
  WorkspaceCleanupRunNowParams
} from '../../../../../shared/rpc-contract/workspace-cleanup-runner-params'
import { requireWorkspaceCleanupRunner } from '../../../../workspaces/cleanup/workspace-cleanup-runner-registry'
import { reportClientUnsavedEditors } from '../../../../workspaces/cleanup/workspace-cleanup-client-unsaved-editors'
import { defineMethod } from '../../core'

/** The cleanup runner of the host that owns the repos; clients merge hosts themselves. */
export const WORKSPACE_CLEANUP_RUNNER_METHODS = [
  defineMethod({
    name: 'workspaceCleanup.preview',
    permission: 'workspace',
    params: WorkspaceCleanupPreviewParams,
    handler: (params, { runtime }) => requireWorkspaceCleanupRunner(runtime).preview(params.rules)
  }),
  defineMethod({
    name: 'workspaceCleanup.runNow',
    permission: 'workspace',
    params: WorkspaceCleanupRunNowParams,
    handler: (params, { runtime }) =>
      requireWorkspaceCleanupRunner(runtime).runNow(params.trigger ?? 'run-now')
  }),
  defineMethod({
    name: 'workspaceCleanup.report',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => requireWorkspaceCleanupRunner(runtime).report()
  }),
  defineMethod({
    name: 'workspaceCleanup.reportUnsavedEditors',
    permission: 'workspace',
    params: WorkspaceCleanupReportUnsavedEditorsParams,
    handler: (params, { runtime, connectionId, signal }) => {
      // Socket-scoped: without a live connection nothing would clear the report.
      if (!connectionId || signal?.aborted) {
        return { recorded: false }
      }
      reportClientUnsavedEditors(runtime, connectionId, params.worktreeIds)
      return { recorded: true }
    }
  })
]
