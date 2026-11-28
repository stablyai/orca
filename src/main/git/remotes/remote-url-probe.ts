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

/** A shared read and the repo config signature taken before its Git read; undefined when unsigned. */
type SharedRemoteUrlRead = { configSignature: Promise<string | undefined>; url: Promise<string> }

type SharedRemoteUrlReads = { open: boolean; reads: Map<string, SharedRemoteUrlRead> }

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

/** Reads a remote URL, or null for an SSH repo, which this process does not serve. Callers that cache
 *  the answer pass the config signature they took just before, so a shared read from older config is
 *  not reused under it. */
export async function readRemoteUrl(
  context: RemoteUrlProbeContext,
  remoteName: string,
  configSignature?: string
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
  if (read && configSignature !== undefined && (await read.configSignature) !== configSignature) {
    read = undefined
  }
  if (!read) {
    // Unsigned callers sign the shared read too, so a later signed caller can trust it.
    const readSignature =
      configSignature !== undefined
        ? Promise.resolve(configSignature)
        : readLocalGitConfigSignature(context)
    read = {
      configSignature: readSignature,
      url: readSignature.then(() => readUncachedRemoteUrl(context, remoteName))
    }
    scope.reads.set(key, read)
  }
  return read.url
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
