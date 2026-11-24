import type { GitAdmissionTier } from '../../../../shared/rpc-contract/source-control/git-admission-tier-params'
import {
  isWslLinkedWorktreeGitRoutingCandidate,
  prepareWslLinkedWorktreeGitRouting,
  usesHostGitForWslLinkedWorktree
} from './wsl-linked-worktree-git-routing'
import { pendingWslWindowsCheckoutGitConfig } from './wsl-windows-checkout-git-probe'
import { settleWslAutomountRoot } from '../../../wsl/filesystem/wsl-automount-root'
import { admitWslGit } from './local-git-runtime-route'

/** Settle checkout ownership, the distro's mount root and Windows-Git config before synchronous routing; null means no drive-checkout command. */
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
    // Paths this Git prints map back to the drive only once the distro's mount root is known.
    if (options.wslDistro) {
      await settleWslAutomountRoot(options.wslDistro, {
        signal: options.signal,
        admit: () => admitWslGit(options)
      })
    }
    await pendingWslWindowsCheckoutGitConfig(args, options)
  })()
}
