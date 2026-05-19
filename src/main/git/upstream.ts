import type { GitUpstreamStatus } from '../../shared/types'
import { isNoUpstreamError, normalizeGitErrorMessage } from '../../shared/git-remote-error'
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

    const tokens = countsStdout.trim().split(/\s+/)
    if (tokens.length !== 2) {
      // Why: 'rev-list --left-right --count HEAD...@{u}' must emit exactly two
      // tokens; anything else (empty stdout, truncation, unexpected locale) is a
      // real failure and must not be silently reported as "in sync" 0/0.
      throw new Error(`Unexpected git rev-list output: ${JSON.stringify(countsStdout)}`)
    }
    const ahead = Number.parseInt(tokens[0]!, 10)
    const behind = Number.parseInt(tokens[1]!, 10)
    if (!Number.isFinite(ahead) || !Number.isFinite(behind) || ahead < 0 || behind < 0) {
      throw new Error(`Unparseable git rev-list counts: ${JSON.stringify(countsStdout)}`)
    }

    return {
      hasUpstream: true,
      upstreamName,
      ahead,
      behind
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
    // Why: parity with gitPush/gitPull/gitFetch — normalize before crossing
    // the IPC boundary so renderers don't see execFile stderr preambles or local paths.
    throw new Error(normalizeGitErrorMessage(error, 'upstream'))
  }
}
