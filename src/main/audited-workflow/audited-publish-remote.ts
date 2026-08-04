// Remote topology and the lease probe (Phase 9 P1).
//
// Remote-name precedence mirrors the app's getConfiguredPushTarget
// (branch.<b>.pushRemote -> remote.pushDefault -> branch.<b>.remote -> origin),
// but READ-ONLY and through the audited boundary: nothing here sets an upstream
// or mutates configuration.
import type { PublishReasonCode } from '../../shared/audited-publish-types'
import {
  buildLsRemoteArgv,
  buildRemoteListArgv,
  buildRemoteNameConfigArgv,
  runAuditedGitPublish,
  runAuditedGitRead
} from './audited-worktree-commands'
import { FULL_OID } from './audited-worktree-identity'

const LS_REMOTE_TIMEOUT_MS = 30_000

async function readConfig(worktreePath: string, key: string): Promise<string | null> {
  const result = await runAuditedGitRead(buildRemoteNameConfigArgv(key), worktreePath)
  if (!result.ok) {
    // `config --get` exits 1 when the key is unset — an expected absence, not a
    // failure, so the caller simply moves to the next candidate.
    return null
  }
  const value = result.stdout.trim()
  return value.length > 0 ? value : null
}

export type ResolveRemoteResult =
  | { ok: true; remote: string }
  | { ok: false; reasonCode: PublishReasonCode }

/**
 * Resolves the remote to publish to, without mutating anything.
 *
 * A remote-name value that is actually a URL is refused rather than guessed at:
 * the audited lane pushes to a NAMED remote so the argv shape stays screenable.
 */
export async function resolvePublishRemote(
  worktreePath: string,
  branchName: string
): Promise<ResolveRemoteResult> {
  const configured =
    (await readConfig(worktreePath, `branch.${branchName}.pushRemote`)) ??
    (await readConfig(worktreePath, 'remote.pushDefault')) ??
    (await readConfig(worktreePath, `branch.${branchName}.remote`))

  const listed = await runAuditedGitRead(buildRemoteListArgv(), worktreePath)
  if (!listed.ok) {
    return { ok: false, reasonCode: 'remote_url_unreadable' }
  }
  const remotes = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (remotes.length === 0) {
    return { ok: false, reasonCode: 'no_remote_configured' }
  }

  // A configured value only counts if it names a remote that actually exists —
  // otherwise a stale config would send the push somewhere unscreenable.
  if (configured && remotes.includes(configured)) {
    return { ok: true, remote: configured }
  }
  if (remotes.includes('origin')) {
    return { ok: true, remote: 'origin' }
  }
  return { ok: false, reasonCode: 'no_remote_configured' }
}

export type RemoteRefProbe =
  | { ok: true; sha: string | null }
  | { ok: false; reasonCode: PublishReasonCode }

/**
 * Reads one remote branch ref — the lease source, and the recovery oracle.
 *
 * CRITICAL: `ls-remote` exits 0 with EMPTY stdout when the ref does not exist.
 * Absence is therefore detected from the OUTPUT, never from the exit code; a
 * naive ok/!ok check would misread a deleted branch as a transport failure and
 * fabricate a verdict. `--exit-code=0` pins that behavior explicitly.
 *
 * `sha: null` means the ref is absent (create-only). A non-ok result means we
 * could not look at all, which is never the same as "it is not there".
 */
export async function probeRemoteRef(
  worktreePath: string,
  remote: string,
  branch: string
): Promise<RemoteRefProbe> {
  const result = await runAuditedGitPublish(buildLsRemoteArgv(remote, branch), worktreePath, {
    timeoutMs: LS_REMOTE_TIMEOUT_MS
  })
  if (!result.ok) {
    return { ok: false, reasonCode: 'remote_ref_unreadable' }
  }
  const line = result.stdout
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  if (!line) {
    return { ok: true, sha: null }
  }
  const sha = line.split(/\s+/)[0] ?? ''
  if (!FULL_OID.test(sha)) {
    return { ok: false, reasonCode: 'remote_ref_unreadable' }
  }
  return { ok: true, sha }
}
