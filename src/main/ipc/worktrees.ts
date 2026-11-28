import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeWorktreeLifecycleEvent } from '../runtime/workspaces/lifecycle/worktree-lifecycle-event'
import { createSenderScopedRequestCancellations } from './renderer-requests/sender-scoped-request-cancellation'
import { registerLazyIpcHandleGroup } from './lazy-ipc-handle-group'
import { registerDetectedWorktreeHandlers } from './worktrees/listing/register-detected-worktree-handlers'
import { registerHostCatalogHandlers } from './worktrees/listing/register-host-catalog-handlers'
import { registerWorktreeCatalogHandlers } from './worktrees/listing/register-worktree-catalog-handlers'
import { registerDetectedWorktreeScanInvalidation } from './worktrees/listing/register-detected-worktree-scan-invalidation'
import { registerSparseCheckoutCacheInvalidation } from './worktrees/listing/register-sparse-checkout-cache-invalidation'
import { registerWorktreeMetadataHandlers } from './worktrees/metadata/register-worktree-metadata-handlers'
import {
  createWorktreeRemovalRegistry,
  type WorktreeIpcContext
} from './worktrees/worktree-ipc-context'

registerDetectedWorktreeScanInvalidation()

// Registration supplies the current window/store; dispose the previous listener before replacing them.
let disposeSparseCheckoutCacheInvalidation: (() => void) | undefined

const WORKTREE_CREATE_CHANNELS = [
  'worktrees:create',
  'worktrees:runApprovedSetup',
  'worktrees:adoptProvisionedRoot'
] as const
const WORKTREE_PREFETCH_CHANNELS = ['worktrees:prefetchCreateBase'] as const
const WORKTREE_REVIEW_BASE_CHANNELS = [
  'worktrees:resolvePrBase',
  'worktrees:resolveMrBase'
] as const
const WORKTREE_REMOVAL_CHANNELS = ['worktrees:previewNestedRemoval', 'worktrees:remove'] as const
const WORKTREE_SLEEP_CHANNELS = [
  'worktrees:sleep',
  'worktrees:sleepReopened',
  'worktrees:resumeSleptPane',
  'worktrees:retireStrandedSleepRecord'
] as const
const WORKTREE_FORGET_CHANNELS = [
  'worktrees:forgetLocal',
  'worktrees:forceDeletePreservedBranch'
] as const
const WORKTREE_BRANCH_AUTO_RENAME_RETRY_CHANNELS = [
  'worktrees:getBranchAutoRenameRetryAvailability',
  'worktrees:retryBranchAutoRename',
  'worktrees:waitBranchAutoRenameAttempt',
  'worktrees:dismissBranchAutoRename'
] as const
const WORKTREE_HOOK_CHECK_CHANNELS = ['hooks:check'] as const
const WORKTREE_HOOK_INSPECTION_CHANNELS = ['hooks:inspectSetupScriptImports'] as const
const WORKTREE_HOOK_FILE_CHANNELS = ['hooks:readIssueCommand', 'hooks:writeIssueCommand'] as const

const WORKTREE_HANDLER_CHANNELS = [
  'worktrees:listRetiredNames',
  'worktrees:listDetected',
  'worktrees:listKnownForExecutionHost',
  'worktrees:forgetRemovedForExecutionHost',
  'worktrees:cancelListDetected',
  'worktrees:scanStartingWslDistro',
  ...WORKTREE_CREATE_CHANNELS,
  ...WORKTREE_PREFETCH_CHANNELS,
  ...WORKTREE_REVIEW_BASE_CHANNELS,
  ...WORKTREE_REMOVAL_CHANNELS,
  ...WORKTREE_SLEEP_CHANNELS,
  ...WORKTREE_FORGET_CHANNELS,
  'worktrees:updateMeta',
  'worktrees:listLineage',
  'worktrees:updateLineage',
  'worktrees:persistSortOrder',
  'worktrees:getBranchRenameFailureOutput',
  ...WORKTREE_BRANCH_AUTO_RENAME_RETRY_CHANNELS,
  ...WORKTREE_HOOK_CHECK_CHANNELS,
  ...WORKTREE_HOOK_INSPECTION_CHANNELS,
  ...WORKTREE_HOOK_FILE_CHANNELS
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
  registerWorktreeMetadataHandlers(context)

  registerLazyIpcHandleGroup(WORKTREE_PREFETCH_CHANNELS, async (ipc) => {
    const { registerWorktreePrefetchHandler } =
      await import('./worktrees/create/register-worktree-prefetch-handler')
    registerWorktreePrefetchHandler(context, ipc)
  })
  registerLazyIpcHandleGroup(WORKTREE_CREATE_CHANNELS, async (ipc) => {
    const { registerWorktreeCreateHandlers } =
      await import('./worktrees/create/register-worktree-create-handlers')
    registerWorktreeCreateHandlers(context, ipc)
  })
  registerLazyIpcHandleGroup(WORKTREE_REVIEW_BASE_CHANNELS, async (ipc) => {
    const { registerReviewBaseHandlers } =
      await import('./worktrees/create/register-review-base-handlers')
    registerReviewBaseHandlers(context, ipc)
  })
  registerLazyIpcHandleGroup(WORKTREE_REMOVAL_CHANNELS, async (ipc) => {
    const { registerWorktreeRemovalHandlers } =
      await import('./worktrees/removal/register-worktree-removal-handlers')
    registerWorktreeRemovalHandlers(context, ipc)
  })
  registerLazyIpcHandleGroup(WORKTREE_SLEEP_CHANNELS, async (ipc) => {
    const { registerWorktreeSleepHandlers } =
      await import('./worktrees/sleep/register-worktree-sleep-handlers')
    registerWorktreeSleepHandlers(context, ipc)
  })
  registerLazyIpcHandleGroup(WORKTREE_FORGET_CHANNELS, async (ipc) => {
    const { registerWorktreeForgetHandlers } =
      await import('./worktrees/removal/register-worktree-forget-handlers')
    registerWorktreeForgetHandlers(context, ipc)
  })
  registerLazyIpcHandleGroup(WORKTREE_BRANCH_AUTO_RENAME_RETRY_CHANNELS, async (ipc) => {
    const { registerBranchAutoRenameRetryHandlers } =
      await import('./worktrees/metadata/register-branch-auto-rename-retry-handlers')
    registerBranchAutoRenameRetryHandlers(context, ipc)
  })
  registerLazyIpcHandleGroup(WORKTREE_HOOK_CHECK_CHANNELS, async (ipc) => {
    const { registerWorktreeHookCheckHandler } =
      await import('./hooks/register-worktree-hook-check-handler')
    registerWorktreeHookCheckHandler(context, ipc)
  })
  registerLazyIpcHandleGroup(WORKTREE_HOOK_INSPECTION_CHANNELS, async (ipc) => {
    const { registerWorktreeHookInspectionHandler } =
      await import('./hooks/register-worktree-hook-inspection-handler')
    registerWorktreeHookInspectionHandler(context, ipc)
  })
  registerLazyIpcHandleGroup(WORKTREE_HOOK_FILE_CHANNELS, async (ipc) => {
    const { registerWorktreeHookFileHandlers } =
      await import('./hooks/register-worktree-hook-file-handlers')
    registerWorktreeHookFileHandlers(context, ipc)
  })
}
