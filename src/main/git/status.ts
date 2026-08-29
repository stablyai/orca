// Entry point for the main-process source-control surface. The implementation lives in
// `./source-control/*`; this file stays the single import path because ~40 modules and tests
// (many via `vi.mock('../git/status')`) already resolve their git reads/writes through it.
export { getStatus } from './source-control/status-read'
export type { GetStatusOptions } from './source-control/get-status-options'
export { getSubmoduleStatus } from './source-control/submodule-status'
export {
  MAX_SUBMODULE_PATHS_CACHE_ENTRIES,
  clearSubmodulePathsCacheForTests,
  getSubmodulePathsCacheCountForTests,
  listSubmodulePaths,
  resolveSubmoduleWorktreePath
} from './source-control/submodule-paths'
export {
  invalidateGitReadCaches,
  runWithGitReadCacheInvalidation
} from './source-control/git-read-cache-invalidation'
export {
  clearEffectiveUpstreamNegativeStatusCache,
  clearEffectiveUpstreamStatusCacheForTests,
  getEffectiveUpstreamStatusCacheCountForTests,
  getEffectiveUpstreamStatusGenerationCountForTests
} from './source-control/effective-upstream-status-cache'
export {
  abortMerge,
  abortRebase,
  detectConflictOperation
} from './source-control/git-conflict-operation'
export { resolveGitDir } from './source-control/resolve-git-dir'
export { getDiff } from './source-control/file-diff'
export { getBranchCompare } from './source-control/branch-compare'
export { getBranchDiff } from './source-control/branch-diff'
export { getCommitCompare } from './source-control/commit-compare'
export { getCommitDiff } from './source-control/commit-diff'
export { bulkStageFiles, bulkUnstageFiles, stageFile, unstageFile } from './source-control/staging'
export { getStagedCommitContext } from './source-control/staged-commit-context'
export { commitChanges } from './source-control/commit-changes'
export {
  bulkDiscardChanges,
  discardChanges,
  isWithinWorktree
} from './source-control/discard-changes'
