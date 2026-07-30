// Reads the six Git/filesystem evidence channels used by crash recovery.
//
// Why six: path absence alone does NOT prove Git made no durable change.
// `git worktree add` can create the branch and the admin record before failing
// mid-checkout, so recovery must look at refs and worktree registration too —
// otherwise a branch-only or registration-only remnant would be misread as
// "nothing happened" and silently re-provisioned.
import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { parseWorktreeList } from '../git/worktree'
import {
  buildGitCommonDirArgv,
  buildGitCommonDirFallbackArgv,
  buildRevParseCommitArgv,
  buildShowRefArgv,
  buildSymbolicRefArgv,
  buildWorktreeListArgv,
  runAuditedGitRead
} from './audited-worktree-commands'
import { canonicalizeAllowingMissing, pathsEqualForHost } from './audited-worktree-managed-root'

export type AuditedWorktreeEvidence = {
  /** E1: intended path exists on disk. */
  pathExists: boolean
  /** E1b: path exists but is not a Git worktree (no .git entry). */
  pathIsNonWorktree: boolean
  /** E2: refs/heads/<intended branch> exists. */
  branchExists: boolean
  /** E3: `git worktree list --porcelain` registers the intended path. */
  registered: boolean
  /** E3b: registration exists but Git flags it prunable (directory gone). */
  registrationPrunable: boolean
  /** E4: <commonDir>/worktrees/<name> administrative record exists. */
  adminRecordExists: boolean
  /** E5: branch tip OID, or null when unreadable. */
  branchTip: string | null
  /** E6: canonical common dir as seen from the source repo. */
  commonDir: string | null
  /** HEAD state inside the worktree, when readable. */
  headSymbolicRef: string | null
  headCommit: string | null
}

export type EvidenceInput = {
  sourceRepoPath: string
  intendedPath: string
  intendedBranch: string
}

export async function readAuditedWorktreeEvidence(
  input: EvidenceInput
): Promise<AuditedWorktreeEvidence> {
  const canonicalIntended = canonicalizeAllowingMissing(input.intendedPath)
  const pathExists = existsSync(canonicalIntended)

  const commonDir = await readCommonDir(input.sourceRepoPath)
  const branchTip = await readBranchTip(input.sourceRepoPath, input.intendedBranch)
  const branchExists = await readBranchExists(input.sourceRepoPath, input.intendedBranch)
  const registration = await readRegistration(input.sourceRepoPath, canonicalIntended)
  const adminRecordExists = readAdminRecord(commonDir, canonicalIntended)

  const head = pathExists ? await readHead(canonicalIntended) : { symbolicRef: null, commit: null }

  return {
    pathExists,
    pathIsNonWorktree: pathExists && !existsSync(join(canonicalIntended, '.git')),
    branchExists,
    registered: registration.registered,
    registrationPrunable: registration.prunable,
    adminRecordExists,
    branchTip,
    commonDir,
    headSymbolicRef: head.symbolicRef,
    headCommit: head.commit
  }
}

export async function readCommonDir(repoPath: string): Promise<string | null> {
  // --path-format=absolute is Git >= 2.31; older Git echoes the unknown flag and
  // exits 0, so fall back whenever the first line is not a usable path.
  const preferred = await runAuditedGitRead(buildGitCommonDirArgv(), repoPath)
  if (preferred.ok) {
    const value = lastNonFlagLine(preferred.stdout)
    if (value) {
      return canonicalizeAllowingMissing(resolveAgainst(repoPath, value))
    }
  }
  const fallback = await runAuditedGitRead(buildGitCommonDirFallbackArgv(), repoPath)
  if (!fallback.ok) {
    return null
  }
  const value = lastNonFlagLine(fallback.stdout)
  return value ? canonicalizeAllowingMissing(resolveAgainst(repoPath, value)) : null
}

function lastNonFlagLine(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('--'))
  return lines.at(-1) ?? null
}

// Older Git may print --git-common-dir relative to the repo (e.g. ".git").
function resolveAgainst(repoPath: string, value: string): string {
  return isAbsoluteLike(value) ? value : join(repoPath, value)
}

function isAbsoluteLike(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

async function readBranchTip(repoPath: string, branch: string): Promise<string | null> {
  const result = await runAuditedGitRead(
    buildRevParseCommitArgv(`refs/heads/${branch}`),
    repoPath
  )
  if (!result.ok) {
    return null
  }
  const value = result.stdout.trim()
  return value.length > 0 ? value : null
}

async function readBranchExists(repoPath: string, branch: string): Promise<boolean> {
  const result = await runAuditedGitRead(buildShowRefArgv(branch), repoPath)
  return result.ok
}

async function readRegistration(
  repoPath: string,
  canonicalIntended: string
): Promise<{ registered: boolean; prunable: boolean }> {
  const result = await runAuditedGitRead(buildWorktreeListArgv(), repoPath)
  if (!result.ok) {
    return { registered: false, prunable: false }
  }
  // Reuses the shared porcelain parser, which already surfaces `prunable` —
  // exactly the registration-without-directory signal recovery needs.
  const entries = parseWorktreeList(result.stdout)
  const match = entries.find((entry) =>
    pathsEqualForHost(canonicalizeAllowingMissing(entry.path), canonicalIntended)
  )
  return { registered: Boolean(match), prunable: Boolean(match?.prunable) }
}

function readAdminRecord(commonDir: string | null, canonicalIntended: string): boolean {
  if (!commonDir) {
    return false
  }
  const worktreesDir = join(commonDir, 'worktrees')
  if (!existsSync(worktreesDir)) {
    return false
  }
  const name = canonicalIntended.split(/[\\/]/).findLast(Boolean)
  if (!name) {
    return false
  }
  const candidate = join(worktreesDir, name)
  try {
    return lstatSync(candidate).isDirectory()
  } catch {
    return false
  }
}

async function readHead(
  worktreePath: string
): Promise<{ symbolicRef: string | null; commit: string | null }> {
  const symbolic = await runAuditedGitRead(buildSymbolicRefArgv(), worktreePath)
  const commit = await runAuditedGitRead(buildRevParseCommitArgv('HEAD'), worktreePath)
  return {
    // symbolic-ref --quiet exits non-zero on a detached HEAD; that is a real
    // signal, not an error to swallow.
    symbolicRef: symbolic.ok && symbolic.stdout.trim() ? symbolic.stdout.trim() : null,
    commit: commit.ok && commit.stdout.trim() ? commit.stdout.trim() : null
  }
}

/** True only when Git provably made no durable change (E1-E4 all absent). */
export function isAllEvidenceAbsent(evidence: AuditedWorktreeEvidence): boolean {
  return (
    !evidence.pathExists &&
    !evidence.branchExists &&
    !evidence.registered &&
    !evidence.adminRecordExists
  )
}
