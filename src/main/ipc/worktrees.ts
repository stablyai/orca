import { registerWorktreeSleepHandlers } from './worktrees/sleep/register-worktree-sleep-handlers'
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

// Registration supplies the current window/store; dispose the previous listener before replacing them.
let disposeSparseCheckoutCacheInvalidation: (() => void) | undefined

const WORKTREE_HANDLER_CHANNELS = [
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
  'worktrees:sleep',
  'worktrees:sleepReopened',
  'worktrees:resumeSleptPane',
  'worktrees:retireStrandedSleepRecord',
  'worktrees:previewNestedRemoval',
  'worktrees:forgetLocal',
  'worktrees:forceDeletePreservedBranch',
  'worktrees:updateMeta',
  'worktrees:listLineage',
  'worktrees:updateLineage',
  'worktrees:persistSortOrder',
  'worktrees:getBranchRenameFailureOutput',
  'hooks:check',
  'hooks:inspectSetupScriptImports',
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
  registerWorktreeSleepHandlers(context)
  registerWorktreeForgetHandlers(context)
  registerWorktreeMetadataHandlers(context)
  registerWorktreeHookCheckHandler(context)
  registerWorktreeHookInspectionHandler(context)
  registerWorktreeHookFileHandlers(context)
}
