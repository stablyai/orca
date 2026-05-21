import type { GitUpstreamStatus } from '../../shared/types'
import { upstreamOnlyCommitsArePatchEquivalent } from '../../shared/git-upstream-status'
import { isNoUpstreamError, normalizeGitErrorMessage } from '../../shared/git-remote-error'
import { getEffectiveGitUpstreamStatus } from '../../shared/git-effective-upstream'
import { gitExecFileAsync } from './runner'

async function getBehindCommitsArePatchEquivalent(
  worktreePath: string,
  upstreamName: string
): Promise<boolean> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['log', '--oneline', '--cherry-mark', '--right-only', `HEAD...${upstreamName}`, '--'],
      { cwd: worktreePath }
    )
    return upstreamOnlyCommitsArePatchEquivalent(stdout)
  } catch {
    // Why: patch-equivalence is an optimization for the rebase case. If the
    // probe fails, keep the conservative pull-first behavior.
    return false
  }
}

export async function getUpstreamStatus(worktreePath: string): Promise<GitUpstreamStatus> {
  try {
    return await getEffectiveGitUpstreamStatus(
      (args) => gitExecFileAsync(args, { cwd: worktreePath }),
      (upstreamName) => getBehindCommitsArePatchEquivalent(worktreePath, upstreamName)
    )
  } catch (error) {
    // Why: we only swallow clearly-no-upstream signals — that's an expected
    // state, not a failure. Other errors (auth, corruption, "not a git
    // repository", sparse-checkout) should surface to the user so they can
    // act on them. The shared isNoUpstreamError helper intentionally omits
    // broad phrases like "no such branch" to avoid masking real errors.
    if (isNoUpstreamError(error)) {
      return {
        hasUpstream: false,
        ahead: 0,
        behind: 0
      }
    }
    // Why: parity with gitPush/gitPull/gitFetch — normalize before crossing
    // the IPC boundary so renderers don't see execFile stderr preambles or local paths.
    throw new Error(normalizeGitErrorMessage(error, 'upstream'))
  }
}
