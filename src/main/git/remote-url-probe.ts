import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  getSshGitProvider,
  getSshGitProviderGeneration,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import {
  gitProbeHostKey,
  isGitHostProbeBlockedError,
  runGuardedGitHostProbe
} from './git-host-probe-breaker'
import { gitExecFileAsync } from './runner'
import { isStableMissingGitRemoteError } from './stable-missing-git-remote-error'
import {
  isWslLinkedWorktreeGitRoutingCandidate,
  prepareWslLinkedWorktreeGitRouting
} from './wsl-linked-worktree-git-routing'

/**
 * The `git remote get-url` probe every forge integration runs to decide whether
 * a repo is theirs (P1-D).
 *
 * Why: it is a local config read, so the only way it outlasts this bound is a
 * wedged host — a dead network mount or stalled WSL interop. Unbounded, the call
 * never returns and every caller above it hangs with it. Passing a timeout is
 * also what arms the runner's kill path; Node's own waits forever on a child
 * that ignores signals. The SSH branch spends the same budget as one deadline
 * over the whole round trip: the relay's own bounds are per-phase and restart on
 * every frame, so a relay dribbling output outlives them.
 */
export const REMOTE_URL_PROBE_TIMEOUT_MS = 30_000

export type RemoteUrlProbeContext = {
  repoPath: string
  connectionId?: string | null
  wslDistro?: string
}

/**
 * Which host executes this probe, resolved the way the runner resolves routing
 * rather than from the caller's hint alone.
 *
 * Why it has to match: a Windows-drive worktree linked into a WSL repo carries a
 * `wslDistro` but runs *host* git, and a `\wsl$` UNC cwd names its distro
 * nowhere else. Key either one wrong and the budget is silently useless — the
 * linked worktree's instant successes would reset the wedged distro's streak on
 * every poll, so the breaker could never open.
 */
async function localProbeHostKey(context: RemoteUrlProbeContext): Promise<string> {
  if (
    isWslLinkedWorktreeGitRoutingCandidate(context.repoPath, context.wslDistro) &&
    (await prepareWslLinkedWorktreeGitRouting(context.repoPath, context.wslDistro))
  ) {
    return gitProbeHostKey({})
  }
  // Why the cwd first: `resolveCommand` reads the cwd's distro before the hint,
  // so identity follows execution. Why the platform gate: off Windows nothing is
  // routed into WSL, and a literal `//wsl$/x` directory is an ordinary path.
  const cwdDistro =
    process.platform === 'win32' ? parseWslUncPath(context.repoPath)?.distro : undefined
  const wslDistro = cwdDistro ?? context.wslDistro
  return gitProbeHostKey(wslDistro ? { wslDistro } : {})
}

/** Reads a remote URL, or null when the repo's SSH runtime is not connected. */
export async function readRemoteUrl(
  context: RemoteUrlProbeContext,
  remoteName: string
): Promise<string | null> {
  if (context.connectionId) {
    const connectionId = context.connectionId
    const provider = getSshGitProvider(connectionId)
    if (!provider) {
      // Costs no git, so there is nothing here for the host's budget to learn.
      return null
    }
    return runGuardedGitHostProbe(
      gitProbeHostKey({
        connectionId,
        connectionGeneration: getSshGitProviderGeneration(connectionId)
      }),
      async () => {
        const { stdout } = await provider.exec(
          ['remote', 'get-url', remoteName],
          context.repoPath,
          { signal: AbortSignal.timeout(REMOTE_URL_PROBE_TIMEOUT_MS) }
        )
        return stdout
      },
      isTransientGitProbeError
    )
  }
  return runGuardedGitHostProbe(
    await localProbeHostKey(context),
    async () => {
      const { stdout } = await gitExecFileAsync(['remote', 'get-url', remoteName], {
        cwd: context.repoPath,
        timeout: REMOTE_URL_PROBE_TIMEOUT_MS,
        ...(context.wslDistro ? { wslDistro: context.wslDistro } : {})
      })
      return stdout
    },
    isTransientGitProbeError
  )
}

const TRANSIENT_PROBE_PATTERNS = [
  /\btimed out\b/i,
  /\bETIMEDOUT\b/,
  /\bECONNRESET\b/,
  /\bEPIPE\b/,
  /connection (?:dropped|closed|refused|reset)/i
]

/**
 * A probe that was killed on its deadline, or died with its transport, says
 * nothing about the remote. Callers must neither cache it as an answer nor
 * report it as "no review": it is an unavailable result, not a negative one.
 */
export function isTransientGitProbeError(error: unknown): boolean {
  // Why: a probe the host's failure budget refused never reached the host, so it
  // stands in for exactly the deadline kill it was issued instead of.
  if (isGitHostProbeBlockedError(error)) {
    return true
  }
  // Why: an abort — this probe's deadline, or a caller cancelling — carries no
  // message a pattern could match, but it is the emptiest answer of all.
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  ) {
    return true
  }
  const parts: string[] = []
  if (error instanceof Error) {
    parts.push(error.message)
  }
  if (typeof error === 'object' && error !== null) {
    const execLike = error as { stderr?: unknown; code?: unknown }
    if (typeof execLike.stderr === 'string') {
      parts.push(execLike.stderr)
    }
    if (typeof execLike.code === 'string') {
      parts.push(execLike.code)
    }
  }
  if (parts.length === 0) {
    parts.push(String(error))
  }
  const text = parts.join('\n')
  return TRANSIENT_PROBE_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * Throws when the remote could not be read, and returns normally for every
 * answer — including a repo with no remote at all. Lets a caller that treats
 * "nothing found" as cacheable tell that apart from a lookup that never got to ask.
 */
export async function assertRemoteUrlReadable(
  context: RemoteUrlProbeContext,
  remoteName = 'origin'
): Promise<void> {
  if (context.connectionId && !getSshGitProvider(context.connectionId)) {
    throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  try {
    await readRemoteUrl(context, remoteName)
  } catch (error) {
    if (isStableMissingGitRemoteError(error)) {
      return
    }
    throw error
  }
}
