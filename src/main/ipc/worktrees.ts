import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService, RuntimeWorktreeLifecycleEvent } from '../runtime/orca-runtime'
import { createSenderScopedRequestCancellations } from './sender-scoped-request-cancellation'
import { registerWorktreeCreateHandlers } from './worktrees/create/register-worktree-create-handlers'
import { registerWorktreePrefetchHandler } from './worktrees/create/register-worktree-prefetch-handler'
import { registerReviewBaseHandlers } from './worktrees/create/register-review-base-handlers'
import { registerWorktreeHookCheckHandler } from './hooks/register-worktree-hook-check-handler'
import { registerWorktreeHookFileHandlers } from './hooks/register-worktree-hook-file-handlers'
import { registerWorktreeHookInspectionHandler } from './hooks/register-worktree-hook-inspection-handler'
import { registerWorktreeHookRunnerHandler } from './hooks/register-worktree-hook-runner-handler'
import { registerDetectedWorktreeHandlers } from './worktrees/listing/register-detected-worktree-handlers'
import { registerHostCatalogHandlers } from './worktrees/listing/register-host-catalog-handlers'
import { registerWorktreeCatalogHandlers } from './worktrees/listing/register-worktree-catalog-handlers'
import { registerDetectedWorktreeScanInvalidation } from './worktrees/listing/register-detected-worktree-scan-invalidation'
import { registerSparseCheckoutCacheInvalidation } from './worktrees/listing/register-sparse-checkout-cache-invalidation'
import { registerWorktreeMetadataHandlers } from './worktrees/metadata/register-worktree-metadata-handlers'
import { registerWorktreeForgetHandlers } from './worktrees/removal/register-worktree-forget-handlers'
import { registerWorktreeRemovalHandlers } from './worktrees/removal/register-worktree-removal-handlers'
import {
  createWorktreeRemovalRegistry,
  type WorktreeIpcContext
} from './worktrees/worktree-ipc-context'

registerDetectedWorktreeScanInvalidation()

// Why not module scope like the invalidation above: this needs `mainWindow`/`store`, which only
// exist once a window is attached, and must track the current ones across re-registration.
let disposeSparseCheckoutCacheInvalidation: (() => void) | undefined

const WORKTREE_HANDLER_CHANNELS = [
  'worktrees:listAll',
  'worktrees:list',
  'worktrees:listRetiredNames',
  'worktrees:listDetected',
  'worktrees:listKnownForExecutionHost',
  'worktrees:forgetRemovedForExecutionHost',
  'worktrees:cancelListDetected',
  'worktrees:create',
  'worktrees:adoptProvisionedRoot',
  'worktrees:prefetchCreateBase',
  'worktrees:resolvePrBase',
  'worktrees:resolveMrBase',
  'worktrees:remove',
  'worktrees:forgetLocal',
  'worktrees:forceDeletePreservedBranch',
  'worktrees:updateMeta',
  'worktrees:listLineage',
  'worktrees:listLineageForHost',
  'worktrees:updateLineage',
  'worktrees:persistSortOrder',
  'worktrees:getBranchRenameFailureOutput',
  'hooks:check',
  'hooks:inspectSetupScriptImports',
  'hooks:createIssueCommandRunner',
  'hooks:readIssueCommand',
  'hooks:writeIssueCommand'
] as const

export function registerWorktreeHandlers(
  mainWindow: BrowserWindow,
  store: Store,
  runtime: OrcaRuntimeService,
  options?: { onWorktreeLifecycle?: (event: RuntimeWorktreeLifecycleEvent) => void }
): void {
  const context: WorktreeIpcContext = {
    mainWindow,
    store,
    runtime,
    ...(options ? { options } : {}),
    detectedWorktreeCancellations: createSenderScopedRequestCancellations(),
    worktreeRemovalsInFlight: createWorktreeRemovalRegistry()
  }

  // Remove all stale registrations before installing any replacement handler.
  for (const channel of WORKTREE_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel)
  }

  disposeSparseCheckoutCacheInvalidation?.()
  disposeSparseCheckoutCacheInvalidation = registerSparseCheckoutCacheInvalidation(
    mainWindow,
    store
  )

  registerWorktreeCatalogHandlers(context)
  registerHostCatalogHandlers(context)
  registerDetectedWorktreeHandlers(context)
  registerWorktreePrefetchHandler(context)
  registerWorktreeCreateHandlers(context)
  registerReviewBaseHandlers(context)
  registerWorktreeRemovalHandlers(context)
  registerWorktreeForgetHandlers(context)
  registerWorktreeMetadataHandlers(context)
  registerWorktreeHookCheckHandler(context)
  registerWorktreeHookRunnerHandler(context)
  registerWorktreeHookInspectionHandler(context)
  registerWorktreeHookFileHandlers(context)
}
