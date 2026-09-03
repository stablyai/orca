export { addWorktree } from './worktree-add'
export {
  configurePushAutoSetupRemote,
  persistWorktreeCreationBase,
  resolveWorktreeAddBaseContext
} from './worktree-add'
export { forceDeleteLocalBranch } from './worktree-branch-removal'
export { parseWorktreeList } from '../../shared/git-worktree-porcelain-parser'
// Unshared by design: verification-after-mutation callers must not join an
// in-flight scan that predates a raw `git worktree prune` or an external client.
// Opt into coalescing with `listWorktreesSharedStrict`.
export { describeCreatedWorktree, listWorktreesStrict } from './worktree-listing'
export { moveWorktree } from './worktree-move'
export {
  WORKTREE_ADD_TIMEOUT_MAX_MS,
  WORKTREE_ADD_TIMEOUT_MS,
  WORKTREE_LIST_TIMEOUT_MS,
  WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS,
  WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS,
  resolveWorktreeAddTimeoutMs
} from './worktree-operation-options'
export type {
  AddWorktreeOptions,
  AddWorktreeResult,
  GitWorktreeExecOptions,
  RemoveWorktreeOptions
} from './worktree-operation-options'
export { assertWorktreeCleanForRemoval } from './worktree-removal-preflight'
export { removeWorktree } from './worktree-removal'
export {
  _getWorktreeScanCacheSizesForTests,
  _resetWorktreeScanCacheForTests,
  listWorktreeGraph,
  listWorktrees,
  listWorktreesSharedStrict
} from './worktree-scan-cache'
export { bumpWorktreeScanGeneration as notifyPreparedWorktreeMutation } from './worktree-scan-cache'
export { addSparseWorktree } from './worktree-sparse-add'
export { parseCoreSparseCheckoutFlag } from './worktree-sparse-state'
