import { AsyncLocalStorage } from 'node:async_hooks'
import { gitExecFileAsync } from '../command-runner/git-exec-file'
import { isStableMissingGitRemoteError } from './stable-missing-git-remote-error'
import type { GitAdmissionTier } from '../../../shared/rpc-contract/source-control/git-admission-tier-params'
import { requireReachableGitRoute } from '../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../shared/execution-host/execution-host'

import { REMOTE_URL_PROBE_TIMEOUT_MS } from './remote-git-probe-timeout'
import { isRemoteListedAbsent } from './remote-name-listing'
import { readLocalGitConfigSignature } from '../../github/repositories/local-git-config-signature'

export { REMOTE_URL_PROBE_TIMEOUT_MS }

export type RemoteUrlProbeContext = {
  repoPath: string
  connectionId?: string | null
  wslDistro?: string
  admissionTier?: GitAdmissionTier
}

/** A URL with the repo config signature taken before Git read it; undefined when it cannot be signed. */
export type SignedRemoteUrl = { url: string; configSignature: string | undefined }

type SharedRemoteUrlReads = { open: boolean; reads: Map<string, Promise<SignedRemoteUrl>> }

const sharedRemoteUrlReads = new AsyncLocalStorage<SharedRemoteUrlReads>()

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
  return (
    await readSharedRemoteUrl(scope, context, remoteName, () =>
      readLocalGitConfigSignature(context)
    )
  ).url
}

/** Like readRemoteUrl, but pairs the URL with the config signature it was read under; a shared read
 *  may predate the caller's own signature. `configSignature` is the caller's, taken just before. */
export async function readSignedRemoteUrl(
  context: RemoteUrlProbeContext,
  remoteName: string,
  configSignature: string | undefined
): Promise<SignedRemoteUrl | null> {
  if (context.connectionId) {
    return null
  }
  const scope = sharedRemoteUrlReads.getStore()
  if (!scope?.open) {
    return { url: await readUncachedRemoteUrl(context, remoteName), configSignature }
  }
  return readSharedRemoteUrl(scope, context, remoteName, async () => configSignature)
}

function readSharedRemoteUrl(
  scope: SharedRemoteUrlReads,
  context: RemoteUrlProbeContext,
  remoteName: string,
  readSignature: () => Promise<string | undefined>
): Promise<SignedRemoteUrl> {
  const key = [
    context.wslDistro ?? '',
    context.admissionTier ?? '',
    context.repoPath,
    remoteName
  ].join('\0')
  let read = scope.reads.get(key)
  if (!read) {
    read = (async () => {
      const configSignature = await readSignature()
      return { url: await readUncachedRemoteUrl(context, remoteName), configSignature }
    })()
    scope.reads.set(key, read)
  }
  return read
}

async function readUncachedRemoteUrl(
  context: RemoteUrlProbeContext,
  remoteName: string
): Promise<string> {
  // A fresh listing signed by the unchanged repo config already answered; Git would say the same.
  if (
    await isRemoteListedAbsent(
      context.repoPath,
      remoteName,
      context.connectionId,
      context.wslDistro ? { wslDistro: context.wslDistro } : {}
    )
  ) {
    throw new Error(`error: No such remote '${remoteName}'`)
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
