import type { GitAdmissionTier } from '../../git/command-runner/git-exec-options'

/** The renderer's `git:status` request. */
export type GitStatusIpcArgs = {
  worktreePath: string
  connectionId?: string
  admissionTier?: GitAdmissionTier
  includeIgnored?: boolean
  includeLineStats?: boolean
  bypassEffectiveUpstreamNegativeCache?: boolean
  reuseLineStats?: boolean
  verifyRebaseOperation?: boolean
  branchLineTotalMergeBase?: string
  requestToken?: string
  /** The active workspace's first status: a user act that may start its WSL distro. */
  wakeWslDistro?: boolean
}
