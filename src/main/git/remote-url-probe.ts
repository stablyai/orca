import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import { gitExecFileAsync } from './runner'
import { isStableMissingGitRemoteError } from './stable-missing-git-remote-error'

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

/** Reads a remote URL, or null when the repo's SSH runtime is not connected. */
export async function readRemoteUrl(
  context: RemoteUrlProbeContext,
  remoteName: string
): Promise<string | null> {
  if (context.connectionId) {
    const provider = getSshGitProvider(context.connectionId)
    if (!provider) {
      return null
    }
    const { stdout } = await provider.exec(['remote', 'get-url', remoteName], context.repoPath, {
      signal: AbortSignal.timeout(REMOTE_URL_PROBE_TIMEOUT_MS)
    })
    return stdout
  }
  const { stdout } = await gitExecFileAsync(['remote', 'get-url', remoteName], {
    cwd: context.repoPath,
    timeout: REMOTE_URL_PROBE_TIMEOUT_MS,
    ...(context.wslDistro ? { wslDistro: context.wslDistro } : {})
  })
  return stdout
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
