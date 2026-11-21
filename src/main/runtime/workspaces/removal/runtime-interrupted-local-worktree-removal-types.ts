import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { RuntimePreservedBranchCleanup } from '../../repositories/runtime-preserved-branch-cleanup'
import type { WorktreeRemovalRecord } from '../../../workspaces/removal/worktree-removal-records'
import type { RuntimeLocalWorktreeRemovalFinishArgs } from './runtime-registered-local-worktree-removal'
import type { WorktreeRemovalExpectation } from '../../../workspaces/removal/worktree-removal-expectation'

export type InterruptedWorktreeRemovalHost = {
  store: RuntimeStore
  acquireWatcherRemoval: (path: string) => Promise<{ finish: (removed: boolean) => Promise<void> }>
  closeWatchers: (path: string) => Promise<void>
  preservedBranchCleanup: Pick<RuntimePreservedBranchCleanup, 'preserveHead' | 'remember'>
  /** A retry's teardown: terminals opened in the folder before the user removed it. */
  stopPtys?: () => Promise<void>
  /** Drops the worktree's host state (metadata, history, caches), as every removal path does. */
  purge: (record: WorktreeRemovalRecord) => void | Promise<void>
  onRemoved: (record: WorktreeRemovalRecord) => void
  publish: (repoId: string) => void
}

export type InterruptedLocalWorktreeRemovalArgs = Pick<
  RuntimeLocalWorktreeRemovalFinishArgs,
  'removedPushTarget' | 'closeWatchers' | 'preserveBranchHead' | 'finishRemoval' | 'expectation'
> & {
  store: RuntimeStore
  record: WorktreeRemovalRecord
  acquireWatcherRemoval: (path: string) => Promise<{ finish: (removed: boolean) => Promise<void> }>
  stopPtys?: () => Promise<void>
  stopSignal: AbortSignal
  /** Set when the resume found the reviewed checkout already gone: bookkeeping only, never deletion. */
  goneCheckout?: WorktreeRemovalExpectation
}
