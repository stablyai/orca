/**
 * Locates the Antigravity CLI credential on the execution hosts Orca knows about.
 *
 * `agy` writes this file itself; reading it is what lets Orca report Antigravity quota
 * for a host with no `agy` process reachable from this machine — an SSH dev box, most
 * commonly. Only the one well-known `agy` path is ever read.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import {
  isRuntimeOwnedSshTargetId,
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { resolveRemoteHomePath } from '../ipc/repos/remote-home-path'
import { resolveFilesystemRouteForHost } from '../providers/execution-host-provider-dispatch'
import { isSshRequestOutcomeUnverifiable } from '../ssh/ssh-channel-multiplexer'
import { listRegisteredSshTargets } from '../ssh/ssh-target-registry'
import {
  isAntigravityCredentialExpired,
  parseAntigravityOAuthCredential,
  type AntigravityOAuthCredential
} from './antigravity-oauth-credential'

const CREDENTIAL_PATH_SEGMENTS = ['.gemini', 'antigravity-cli', 'antigravity-oauth-token'] as const

export type AntigravityHostCredential = {
  credential: AntigravityOAuthCredential
  hostId: ExecutionHostId
  hostLabel: string
}

export type AntigravityCredentialLookup =
  | { status: 'ok'; found: AntigravityHostCredential }
  | { status: 'missing' }
  | { status: 'expired'; hostLabel: string }
  /** Contact with a remote host was lost; absence was never established. */
  | { status: 'unverifiable'; hostLabel: string; message: string }

type HostReadOutcome =
  | { kind: 'ok'; credential: AntigravityOAuthCredential }
  | { kind: 'absent' }
  | { kind: 'unverifiable'; message: string }

async function readLocalCredential(): Promise<HostReadOutcome> {
  try {
    const raw = await readFile(join(homedir(), ...CREDENTIAL_PATH_SEGMENTS), 'utf8')
    const credential = parseAntigravityOAuthCredential(raw)
    return credential ? { kind: 'ok', credential } : { kind: 'absent' }
  } catch {
    return { kind: 'absent' }
  }
}

async function readSshCredential(targetId: string): Promise<HostReadOutcome> {
  const route = resolveFilesystemRouteForHost(toSshExecutionHostId(targetId))
  // Why: a target the user has not connected was never contacted, so it is not evidence
  // either way — turning every idle target into an error would drown the real answer.
  if (route.kind !== 'ssh' || !route.provider) {
    return { kind: 'absent' }
  }
  const provider = route.provider
  try {
    const home = await resolveRemoteHomePath(route.connectionId, '~')
    const result = await provider.readFile(posix.join(home, ...CREDENTIAL_PATH_SEGMENTS))
    const credential = parseAntigravityOAuthCredential(result.content)
    return credential ? { kind: 'ok', credential } : { kind: 'absent' }
  } catch (error) {
    // Why: a relayed error loses errno, so "no sign-in here" and "link dropped" are
    // only separable by the transport verdict (docs/reference/ssh-execution-boundary.md).
    return isSshRequestOutcomeUnverifiable(error)
      ? { kind: 'unverifiable', message: 'Remote host did not answer.' }
      : { kind: 'absent' }
  }
}

type HostCandidate = {
  hostId: ExecutionHostId
  label: string
  read: () => Promise<HostReadOutcome>
}

function candidateHosts(): HostCandidate[] {
  const remote = listRegisteredSshTargets()
    .filter((target) => !target.owner && !isRuntimeOwnedSshTargetId(target.id))
    .map((target) => ({
      hostId: toSshExecutionHostId(target.id),
      label: target.label || target.host,
      read: () => readSshCredential(target.id)
    }))
  return [
    { hostId: LOCAL_EXECUTION_HOST_ID, label: 'this machine', read: readLocalCredential },
    ...remote
  ]
}

/**
 * First host holding a usable credential wins, local before remote. An expired or
 * unverifiable host is remembered only as the answer to report when no host succeeds.
 */
export async function findAntigravityCredential(
  now: number = Date.now()
): Promise<AntigravityCredentialLookup> {
  let fallback: AntigravityCredentialLookup | null = null
  for (const host of candidateHosts()) {
    const outcome = await host.read()
    if (outcome.kind === 'ok' && !isAntigravityCredentialExpired(outcome.credential, now)) {
      return {
        status: 'ok',
        found: { credential: outcome.credential, hostId: host.hostId, hostLabel: host.label }
      }
    }
    if (outcome.kind === 'ok') {
      fallback ??= { status: 'expired', hostLabel: host.label }
    } else if (outcome.kind === 'unverifiable') {
      fallback ??= { status: 'unverifiable', hostLabel: host.label, message: outcome.message }
    }
  }
  return fallback ?? { status: 'missing' }
}
