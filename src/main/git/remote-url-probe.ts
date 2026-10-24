import { gitExecFileAsync } from './runner'
import { isStableMissingGitRemoteError } from './stable-missing-git-remote-error'
import type { GitAdmissionTier } from './command-runner/git-exec-options'
import { requireReachableGitRoute } from '../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../shared/execution-host'

// Bound config probes so stalled mounts or WSL cannot hold every forge lookup indefinitely.
export const REMOTE_URL_PROBE_TIMEOUT_MS = 30_000

export type RemoteUrlProbeContext = {
  repoPath: string
  connectionId?: string | null
  wslDistro?: string
  admissionTier?: GitAdmissionTier
}

/** Reads a remote URL, or null for an SSH repo, which this process does not serve. */
export async function readRemoteUrl(
  context: RemoteUrlProbeContext,
  remoteName: string
): Promise<string | null> {
  if (context.connectionId) {
    return null
  }
  const { stdout } = await gitExecFileAsync(['remote', 'get-url', remoteName], {
    cwd: context.repoPath,
    timeout: REMOTE_URL_PROBE_TIMEOUT_MS,
    ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}),
    ...(context.admissionTier ? { admissionTier: context.admissionTier } : {})
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

/** Timeout or transport failure leaves remote state unknown; never cache it as absence. */
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

/** Throw on unavailable reads; a proven missing remote is a valid negative answer. */
export async function assertRemoteUrlReadable(
  context: RemoteUrlProbeContext,
  remoteName = 'origin'
): Promise<void> {
  requireReachableGitRoute(getConnectionExecutionHostId(context.connectionId))
  try {
    await readRemoteUrl(context, remoteName)
  } catch (error) {
    if (isStableMissingGitRemoteError(error)) {
      return
    }
    throw error
  }
}
