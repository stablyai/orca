import type { GitAdmissionTier } from './command-runner/git-exec-options'
import {
  isWslLinkedWorktreeGitRoutingCandidate,
  prepareWslLinkedWorktreeGitRouting,
  usesHostGitForWslLinkedWorktree
} from './wsl-linked-worktree-git-routing'
import { pendingWslWindowsCheckoutGitConfig } from './wsl-windows-checkout-git-probe'

/** Settle checkout ownership and Windows-Git config before synchronous routing; null means no drive-checkout command. */
export function pendingWslDriveCheckoutGitRouting(
  args: readonly string[],
  options: {
    cwd: string
    wslDistro?: string
    signal?: AbortSignal
    admissionTier?: GitAdmissionTier
  }
): Promise<void> | null {
  if (!isWslLinkedWorktreeGitRoutingCandidate(options.cwd, options.wslDistro)) {
    return null
  }
  return (async () => {
    await prepareWslLinkedWorktreeGitRouting(options.cwd, options.wslDistro, {
      signal: options.signal
    })
    if (usesHostGitForWslLinkedWorktree(options.cwd, options.wslDistro)) {
      return
    }
    await pendingWslWindowsCheckoutGitConfig(args, options)
  })()
}
