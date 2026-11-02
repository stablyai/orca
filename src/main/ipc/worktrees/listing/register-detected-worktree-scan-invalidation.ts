import { registerWorktreeChangeInvalidator } from '../../worktree-change-invalidators'
import { invalidateDetectedWorktreeScanCache } from './detected-worktree-scan-cache'

export function registerDetectedWorktreeScanInvalidation(): void {
  registerWorktreeChangeInvalidator(invalidateDetectedWorktreeScanCache)
}
