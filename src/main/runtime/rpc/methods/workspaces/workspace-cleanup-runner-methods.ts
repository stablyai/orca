import { readWorktreeMetaForHost } from '../../../../persistence/host-qualified-worktree-meta'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import {
  WorkspaceCleanupPolicyReadParams,
  WorkspaceCleanupGuardParam,
  WorkspaceCleanupChangeParams,
  WorkspaceCleanupSettleParams,
  WorkspaceCleanupInspectKeptParams,
  WorkspaceCleanupPinBatchParams,
  WorkspaceCleanupPinParams
} from '../../../../../shared/rpc-contract/workspace-cleanup/workspace-cleanup-change-params'
import {
  settleWorkspaceCleanupPolicyWrite,
  persistWorkspaceCleanupPolicy,
  readDurableWorkspaceCleanupPolicy,
  reserveWorkspaceCleanupPolicyWrite,
  recoverWorkspaceCleanupPolicyWrites
} from '../../../../workspaces/cleanup/workspace-cleanup-policy-write'
import {
  pinWorkspaceForCleanup,
  pinWorkspacesForCleanup
} from '../../../../workspaces/cleanup/workspace-cleanup-pin'
import { hasWorkspaceCleanupAdmission } from '../../../../workspaces/cleanup/workspace-cleanup-admission'
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
    name: 'workspaceCleanup.policyState',
    permission: 'workspace',
    params: WorkspaceCleanupPolicyReadParams,
    handler: (params, { runtime }) =>
      readDurableWorkspaceCleanupPolicy(runtime.requireStore(), () =>
        requireWorkspaceCleanupRunner(runtime).readPolicy(params.repoId)
      )
  }),
  defineMethod({
    name: 'workspaceCleanup.reservePolicyWrite',
    permission: 'workspace',
    params: WorkspaceCleanupGuardParam,
    handler: (params, { runtime }) => {
      reserveWorkspaceCleanupPolicyWrite(runtime.requireStore(), params)
      return { reserved: true }
    }
  }),
  defineMethod({
    name: 'workspaceCleanup.recoverPolicyWrites',
    permission: 'workspace',
    params: WorkspaceCleanupPolicyReadParams,
    handler: (params, { runtime }) => {
      recoverWorkspaceCleanupPolicyWrites(runtime.requireStore())
      return readDurableWorkspaceCleanupPolicy(runtime.requireStore(), () =>
        requireWorkspaceCleanupRunner(runtime).readPolicy(params.repoId)
      )
    }
  }),
  defineMethod({
    name: 'workspaceCleanup.previewChange',
    permission: 'workspace',
    params: WorkspaceCleanupChangeParams,
    handler: (params, { runtime }) =>
      requireWorkspaceCleanupRunner(runtime).previewChange(
        params.change,
        params.expected,
        params.fresh
      )
  }),
  defineMethod({
    name: 'workspaceCleanup.settlePolicyWrite',
    permission: 'workspace',
    params: WorkspaceCleanupSettleParams,
    handler: async (params, { runtime }) => {
      const outcome = settleWorkspaceCleanupPolicyWrite(params.id, params.expiresAt)
      if (outcome === 'applied') {
        await persistWorkspaceCleanupPolicy(runtime.requireStore())
      }
      return { outcome }
    }
  }),
  defineMethod({
    name: 'workspaceCleanup.inspectKept',
    permission: 'workspace',
    params: WorkspaceCleanupInspectKeptParams,
    handler: (params, { runtime }) => {
      const store = runtime.requireStore()
      if (!store.runDurableMutation) {
        throw new Error('workspace_cleanup_pin_unsupported')
      }
      return store.runDurableMutation(() => {
        const deleted: string[] = [],
          pinned: string[] = [],
          tooLate: string[] = []
        for (const row of params.rows) {
          const meta = readWorktreeMetaForHost(store, row.worktreeId, LOCAL_EXECUTION_HOST_ID)
          if (meta?.instanceId !== row.instanceId) {
            deleted.push(row.worktreeId)
          } else if (hasWorkspaceCleanupAdmission(store, row.worktreeId, row.instanceId)) {
            tooLate.push(row.worktreeId)
          } else if (meta.isPinned) {
            pinned.push(row.worktreeId)
          }
        }
        return { value: { deleted, pinned, tooLate }, persist: 'if-dirty' }
      })
    }
  }),
  defineMethod({
    name: 'workspaceCleanup.pinBatch',
    permission: 'workspace',
    params: WorkspaceCleanupPinBatchParams,
    handler: (params, { runtime }) => pinWorkspacesForCleanup(runtime, params.rows)
  }),
  defineMethod({
    name: 'workspaceCleanup.pin',
    permission: 'workspace',
    params: WorkspaceCleanupPinParams,
    handler: async (params, { runtime }) => {
      await pinWorkspaceForCleanup(runtime, params.worktreeId, params.instanceId)
      return { pinned: true }
    }
  }),
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
