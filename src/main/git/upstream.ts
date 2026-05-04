import type { GitUpstreamStatus } from '../../shared/types'
import { isNoUpstreamError } from '../../shared/git-remote-error'
import { gitExecFileAsync } from './runner'

export async function getUpstreamStatus(worktreePath: string): Promise<GitUpstreamStatus> {
  try {
    const { stdout: upstreamStdout } = await gitExecFileAsync(
      ['rev-parse', '--abbrev-ref', 'HEAD@{u}'],
      {
        cwd: worktreePath
      }
    )
    const upstreamName = upstreamStdout.trim()
    if (!upstreamName) {
      return { hasUpstream: false, ahead: 0, behind: 0 }
    }

    const { stdout: countsStdout } = await gitExecFileAsync(
      ['rev-list', '--left-right', '--count', 'HEAD...@{u}'],
      {
        cwd: worktreePath
      }
    )

    const [aheadText = '0', behindText = '0'] = countsStdout.trim().split(/\s+/)
    const ahead = Number.parseInt(aheadText, 10)
    const behind = Number.parseInt(behindText, 10)

    return {
      hasUpstream: true,
      upstreamName,
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0
    }
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
    throw error
  }
}
