import { AsyncLocalStorage } from 'node:async_hooks'
import { gitExecFileAsync } from '../command-runner/git-exec-file'
import { isStableMissingGitRemoteError } from './stable-missing-git-remote-error'
import type { GitAdmissionTier } from '../../../shared/rpc-contract/source-control/git-admission-tier-params'
import { requireReachableGitRoute } from '../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../shared/execution-host/execution-host'
import { readLocalGitConfigSignature } from '../../github/repositories/local-git-config-signature'

// Bound config probes so stalled mounts or WSL cannot hold every forge lookup indefinitely.
export const REMOTE_URL_PROBE_TIMEOUT_MS = 30_000

export type RemoteUrlProbeContext = {
  repoPath: string
  connectionId?: string | null
  wslDistro?: string
  admissionTier?: GitAdmissionTier
}

type SharedRemoteUrlReads = { open: boolean; reads: Map<string, Promise<string>> }

const sharedRemoteUrlReads = new AsyncLocalStorage<SharedRemoteUrlReads>()

// A confirmed missing remote stays missing until the repo's Git config changes; the TTL covers global config the signature can't see.
const MISSING_REMOTE_TTL_MS = 5 * 60_000
const MISSING_REMOTE_MAX_ENTRIES = 500
// One miss can race a `git remote add`; a later miss that started after it was recorded, under the same signature, confirms it.
type MissingRemote = {
  error: unknown
  signature: string
  expiresAt: number
  confirmed: boolean
  recordedSeq: number
}
const missingRemotes = new Map<string, MissingRemote>()
let missingRemoteSeq = 0

/** @internal - exposed for tests only */
export function _resetMissingRemoteCache(): void {
  missingRemotes.clear()
}

/** Reads each remote URL at most once while `work` runs, so a provider-by-provider scan shares one read. */
export async function withSharedRemoteUrlReads<T>(work: () => Promise<T>): Promise<T> {
  const scope: SharedRemoteUrlReads = { open: true, reads: new Map() }
  try {
    return await sharedRemoteUrlReads.run(scope, work)
  } finally {
    // Work scheduled from inside the scope must read fresh Git config later.
    scope.open = false
    scope.reads.clear()
  }
}

/** Reads a remote URL, or null for an SSH repo, which this process does not serve. */
export async function readRemoteUrl(
  context: RemoteUrlProbeContext,
  remoteName: string
): Promise<string | null> {
  if (context.connectionId) {
    return null
  }
  const scope = sharedRemoteUrlReads.getStore()
  if (!scope?.open) {
    return readUncachedRemoteUrl(context, remoteName)
  }
  const key = [
    context.wslDistro ?? '',
    context.admissionTier ?? '',
    context.repoPath,
    remoteName
  ].join('\0')
  let read = scope.reads.get(key)
  if (!read) {
    read = readUncachedRemoteUrl(context, remoteName)
    scope.reads.set(key, read)
  }
  return read
}

function missingRemoteKey(context: RemoteUrlProbeContext, remoteName: string): string {
  return [context.wslDistro ?? '', context.repoPath, remoteName].join('\0')
}

function readConfigSignature(context: RemoteUrlProbeContext): Promise<string | undefined> {
  return readLocalGitConfigSignature({
    repoPath: context.repoPath,
    ...(context.wslDistro ? { wslDistro: context.wslDistro } : {})
  })
}

/** The remembered "No such remote" error while the repo's Git config is unchanged, else undefined. */
async function currentMissingRemote(
  context: RemoteUrlProbeContext,
  remoteName: string
): Promise<MissingRemote | undefined> {
  const key = missingRemoteKey(context, remoteName)
  const missing = missingRemotes.get(key)
  if (!missing) {
    return undefined
  }
  if (
    !missing.confirmed ||
    missing.expiresAt <= Date.now() ||
    missing.signature !== (await readConfigSignature(context))
  ) {
    return undefined
  }
  return missing
}

/** True when Git already confirmed this local remote is missing and the repo's config hasn't changed since. */
export async function isRemoteKnownMissing(
  context: RemoteUrlProbeContext,
  remoteName: string
): Promise<boolean> {
  return !context.connectionId && (await currentMissingRemote(context, remoteName)) !== undefined
}

async function readUncachedRemoteUrl(
  context: RemoteUrlProbeContext,
  remoteName: string
): Promise<string> {
  const missing = await currentMissingRemote(context, remoteName)
  if (missing) {
    throw missing.error
  }
  const startedSeq = ++missingRemoteSeq
  try {
    const { stdout } = await gitExecFileAsync(['remote', 'get-url', remoteName], {
      cwd: context.repoPath,
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS,
      ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}),
      ...(context.admissionTier ? { admissionTier: context.admissionTier } : {})
    })
    missingRemotes.delete(missingRemoteKey(context, remoteName))
    return stdout
  } catch (error) {
    if (isStableMissingGitRemoteError(error)) {
      const key = missingRemoteKey(context, remoteName)
      const signature = await readConfigSignature(context)
      // Without a signature (WSL, unreadable config) a later `git remote add` can't be noticed, so don't remember.
      if (signature !== undefined) {
        const previous = missingRemotes.get(key)
        rememberMissingRemote(key, {
          error,
          signature,
          expiresAt: Date.now() + MISSING_REMOTE_TTL_MS,
          confirmed:
            previous !== undefined &&
            previous.signature === signature &&
            previous.expiresAt > Date.now() &&
            // A miss that overlapped the confirming one must not undo it.
            (previous.confirmed || previous.recordedSeq < startedSeq),
          recordedSeq: ++missingRemoteSeq
        })
      }
    }
    throw error
  }
}

function rememberMissingRemote(key: string, entry: MissingRemote): void {
  // Re-insert so eviction drops the least recently refreshed entry.
  missingRemotes.delete(key)
  missingRemotes.set(key, entry)
  while (missingRemotes.size > MISSING_REMOTE_MAX_ENTRIES) {
    const oldest = missingRemotes.keys().next()
    if (oldest.done) {
      return
    }
    missingRemotes.delete(oldest.value)
  }
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
