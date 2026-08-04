// Phases P0-P3 — the Git side of the publish protocol (Phase 9).
//
// PHASE ORDER IS LOAD-BEARING:
//   P0  verify local identity   -> HEAD and branch tip both == committed_sha
//   P1  resolve remote + lease  -> ls-remote gives expected_remote_sha
//   P2  leased push             -> the ONE network mutation
//   P3  confirm via ls-remote   -> durable only once the remote is re-read
//
// P3 exists because a push exit code proves nothing in either direction: the
// server may accept the ref before the connection drops (non-zero exit, work
// landed), and "Everything up-to-date" is a zero exit that pushed nothing. The
// remote is therefore always re-probed before any outcome is decided.
import type { PublishReasonCode } from '../../shared/audited-publish-types'
import {
  buildLeasedPushArgv,
  buildRevParseCommitArgv,
  buildSymbolicRefArgv,
  buildSymbolicRefQuietArgv,
  runAuditedGitPublish,
  runAuditedGitRead
} from './audited-worktree-commands'
import { FULL_OID } from './audited-worktree-identity'

const PUSH_TIMEOUT_MS = 120_000

export type LocalIdentityResult = { ok: true } | { ok: false; reasonCode: PublishReasonCode }

/**
 * P0 — re-verify local identity IMMEDIATELY before the push.
 *
 * verifyWorktreeForTask awaits, so its snapshot is stale by the time a network
 * command could spawn. This re-reads Git directly so a worktree that moved in
 * that window is caught before anything leaves the machine.
 */
export async function verifyLocalPublishIdentity(args: {
  worktreePath: string
  branchName: string
  committedSha: string
}): Promise<LocalIdentityResult> {
  const symbolic = await runAuditedGitRead(buildSymbolicRefArgv(), args.worktreePath)
  if (!symbolic.ok) {
    return { ok: false, reasonCode: 'branch_not_symbolic' }
  }
  if (symbolic.stdout.trim() !== `refs/heads/${args.branchName}`) {
    return { ok: false, reasonCode: 'branch_not_symbolic' }
  }

  const head = await runAuditedGitRead(buildRevParseCommitArgv('HEAD'), args.worktreePath)
  if (!head.ok || head.stdout.trim() !== args.committedSha) {
    return { ok: false, reasonCode: 'head_not_at_committed_sha' }
  }

  const tip = await runAuditedGitRead(
    buildRevParseCommitArgv(`refs/heads/${args.branchName}`),
    args.worktreePath
  )
  if (!tip.ok || tip.stdout.trim() !== args.committedSha) {
    return { ok: false, reasonCode: 'branch_tip_not_at_committed_sha' }
  }

  return { ok: true }
}

export type PushAttemptResult = { ok: true } | { ok: false; reasonCode: PublishReasonCode }

/**
 * Classifies a push failure from stderr into a closed code.
 *
 * The stderr text is consumed HERE and discarded — it never reaches a projection
 * or a log. A push URL can embed `https://<token>@host`, so nothing raw escapes.
 */
export function classifyPushFailure(stderr: string): PublishReasonCode {
  const lower = stderr.toLowerCase()
  if (lower.includes('stale info') || lower.includes('force-with-lease')) {
    return 'push_rejected_stale_lease'
  }
  if (lower.includes('non-fast-forward') || lower.includes('fetch first')) {
    return 'push_rejected_non_fast_forward'
  }
  if (
    lower.includes('authentication') ||
    lower.includes('permission denied') ||
    lower.includes('access denied') ||
    lower.includes('could not read username') ||
    lower.includes('terminal prompts disabled') ||
    lower.includes('403')
  ) {
    return 'push_auth_failed'
  }
  if (
    lower.includes('could not resolve host') ||
    lower.includes('connection refused') ||
    lower.includes('connection timed out') ||
    lower.includes('network is unreachable') ||
    lower.includes('operation timed out') ||
    lower.includes('unable to access')
  ) {
    return 'push_network_unavailable'
  }
  return 'push_failed'
}

/**
 * P2 — the ONE network mutation.
 *
 * Returns a result rather than throwing, and the result is ADVISORY: the caller
 * must still run P3 before deciding anything, because neither exit code proves
 * what the remote now holds.
 */
export async function runLeasedPush(args: {
  worktreePath: string
  remote: string
  branchName: string
  sha: string
  expectedRemoteSha: string | null
}): Promise<PushAttemptResult> {
  const result = await runAuditedGitPublish(
    buildLeasedPushArgv({
      remote: args.remote,
      branch: args.branchName,
      sha: args.sha,
      expectedRemoteSha: args.expectedRemoteSha
    }),
    args.worktreePath,
    { timeoutMs: PUSH_TIMEOUT_MS }
  )
  if (!result.ok) {
    return { ok: false, reasonCode: classifyPushFailure(result.stderr) }
  }
  return { ok: true }
}

/**
 * Resolves the base branch a review request should target, network-free.
 *
 * Reads the remote's recorded HEAD symref (written at clone time) and falls back
 * to the conventional names. Returns a bare branch name, never a full ref, since
 * that is what the provider APIs expect.
 */
export async function resolveBaseBranch(
  worktreePath: string,
  remote: string
): Promise<string | null> {
  const head = await runAuditedGitRead(
    buildSymbolicRefQuietArgv(`refs/remotes/${remote}/HEAD`),
    worktreePath
  )
  if (head.ok) {
    const value = head.stdout.trim()
    const prefix = `refs/remotes/${remote}/`
    if (value.startsWith(prefix)) {
      const branch = value.slice(prefix.length)
      if (branch.length > 0) {
        return branch
      }
    }
  }
  for (const candidate of ['main', 'master']) {
    const probe = await runAuditedGitRead(
      buildRevParseCommitArgv(`refs/remotes/${remote}/${candidate}`),
      worktreePath
    )
    if (probe.ok && FULL_OID.test(probe.stdout.trim())) {
      return candidate
    }
  }
  return null
}
