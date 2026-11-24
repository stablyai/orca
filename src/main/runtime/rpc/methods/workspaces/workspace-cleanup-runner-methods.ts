import {
  WorkspaceCleanupCodexHistoryDiskUsageParams,
  WorkspaceCleanupPreviewParams,
  WorkspaceCleanupReleaseCodexHistoryDiskUsageParams,
  WorkspaceCleanupReportUnsavedEditorsParams,
  WorkspaceCleanupRunNowParams
} from '../../../../../shared/rpc-contract/workspace-cleanup/workspace-cleanup-runner-params'
import { requireWorkspaceCleanupRunner } from '../../../../workspaces/cleanup/workspace-cleanup-runner-registry'
import { reportClientUnsavedEditors } from '../../../../workspaces/cleanup/workspace-cleanup-client-unsaved-editors'
import {
  getCodexHistoryDiskUsage,
  releaseCodexHistoryDiskUsage
} from '../../../../codex/history/disk-usage/codex-history-disk-usage'
import { defineMethod, type RpcContext } from '../../core'

// Ids come from clients, so one socket can't release another's read.
function codexHistoryConsumer(connectionId: string | undefined, consumerId: string): string {
  return connectionId ? JSON.stringify([connectionId, consumerId]) : consumerId
}

/** A window that reloads, crashes or disconnects never sends its release; its connection does. */
async function readCodexHistoryDiskUsage(
  consumerId: string | undefined,
  { runtime, connectionId, signal }: RpcContext
): ReturnType<typeof getCodexHistoryDiskUsage> {
  const settings = runtime.requireStore().getSettings()
  if (!consumerId) {
    return getCodexHistoryDiskUsage(settings)
  }
  const consumer = codexHistoryConsumer(connectionId, consumerId)
  let waiting = true
  const release = (): void => {
    if (waiting) {
      releaseCodexHistoryDiskUsage(consumer)
    }
  }
  const usage = getCodexHistoryDiskUsage(settings, consumer)
  const registration = runtime.registerOwnedSubscriptionCleanup(
    `codex-history-disk-usage:${consumer}`,
    release,
    connectionId
  )
  signal?.addEventListener('abort', release, { once: true })
  if (signal?.aborted) {
    release()
  }
  try {
    return await usage
  } finally {
    waiting = false
    signal?.removeEventListener('abort', release)
    registration.releaseIfCurrent()
  }
}

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
    name: 'workspaceCleanup.codexHistoryDiskUsage',
    permission: 'workspace',
    params: WorkspaceCleanupCodexHistoryDiskUsageParams,
    handler: (params, ctx) => readCodexHistoryDiskUsage(params.consumerId, ctx)
  }),
  defineMethod({
    name: 'workspaceCleanup.releaseCodexHistoryDiskUsage',
    permission: 'workspace',
    params: WorkspaceCleanupReleaseCodexHistoryDiskUsageParams,
    handler: (params, { connectionId }) => {
      releaseCodexHistoryDiskUsage(codexHistoryConsumer(connectionId, params.consumerId))
      return { released: true }
    }
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
      reportClientUnsavedEditors(runtime, connectionId, params.reporterId ?? '', params.worktreeIds)
      return { recorded: true }
    }
  })
]
