// Why this module exists: every dev checkout resolved userData to the same `<appData>/orca-dev`
// directory, so two `pnpm dev` instances from different worktrees shared one profile. The
// single-instance lock is skipped in dev on purpose (#1419), so the second instance boots fully and
// overwrites the first's `orca-runtime.json`, terminal daemon, and generated CLI shim. Nothing
// errors -- both windows work -- but `orca <cmd>` silently retargets the last instance to start, and
// the runtime record only self-heals once a pid is dead (#10840, which documents that two live
// runtimes on one profile fight over the file).
//
// The profile directory is the one identity axis that is free to vary: it is set through
// `app.setPath('userData')`, not `app.setName()`, so the dev bundle's cdhash and the shared
// "Orca Dev Safe Storage" Keychain item both stay put (#15183).

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const SHARED_DEV_PROFILE_DIR_NAME = 'orca-dev'
export const DEV_PROFILE_OWNER_FILE = 'dev-profile-owner.json'

export function getDevProfileBaseDir(platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    return path.join(env.HOME ?? '', 'Library', 'Application Support')
  }
  if (platform === 'win32') {
    return env.APPDATA ?? path.join(env.USERPROFILE ?? '', 'AppData', 'Roaming')
  }
  return env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? '', '.config')
}

// Why: the directory name is addressed by hand (`"<profile>/cli/bin/orca" status`), so keep it
// legible rather than hashing every checkout into an opaque path.
export function sanitizeProfileSegment(value) {
  const cleaned = (value ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
  return cleaned || 'worktree'
}

function shortRepoRootHash(repoRoot) {
  return createHash('sha1').update(repoRoot).digest('hex').slice(0, 6)
}

/**
 * Which userData directory this checkout owns.
 *
 * `readOwnerRepoRoot(dir)` returns the repoRoot recorded in that directory's owner marker, or null
 * when the directory is unclaimed (never used, or predates this marker). It is injected so the
 * decision stays testable without a filesystem.
 *
 * The legacy shared directory is adopted rather than abandoned: an existing developer's main
 * checkout keeps the profile it has always used, and only the checkouts that would have collided
 * with it get a new one. Adoption is restricted to a primary worktree so a linked worktree cannot
 * claim the profile its own main checkout is about to want.
 */
export function resolveDevUserDataProfile({
  repoRoot,
  baseDir,
  isPrimaryWorktree,
  worktreeName,
  readOwnerRepoRoot,
  env = process.env
}) {
  const override = env.ORCA_DEV_USER_DATA_PATH?.trim()
  if (override) {
    return { path: override, kind: 'override', shouldClaim: false }
  }

  const sharedPath = path.join(baseDir, SHARED_DEV_PROFILE_DIR_NAME)
  if (env.ORCA_DEV_SHARED_PROFILE === '1') {
    return { path: sharedPath, kind: 'shared-forced', shouldClaim: false }
  }

  const sharedOwner = readOwnerRepoRoot(sharedPath)
  if (isPrimaryWorktree && (sharedOwner === null || sharedOwner === repoRoot)) {
    return { path: sharedPath, kind: 'shared', shouldClaim: true }
  }

  const named = path.join(
    baseDir,
    `${SHARED_DEV_PROFILE_DIR_NAME}-${sanitizeProfileSegment(worktreeName)}`
  )
  const namedOwner = readOwnerRepoRoot(named)
  if (namedOwner === null || namedOwner === repoRoot) {
    return { path: named, kind: 'worktree', shouldClaim: true }
  }

  // Why: two checkouts can share a directory name (`~/a/sandbox` and `~/b/sandbox`), and handing
  // both the same profile would reintroduce exactly the collision this module exists to prevent.
  return {
    path: `${named}-${shortRepoRootHash(repoRoot)}`,
    kind: 'worktree-disambiguated',
    shouldClaim: true
  }
}

export function readDevProfileOwner(profileDir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(profileDir, DEV_PROFILE_OWNER_FILE), 'utf8'))
    return typeof parsed?.repoRoot === 'string' && parsed.repoRoot ? parsed.repoRoot : null
  } catch {
    return null
  }
}

/**
 * Record which checkout owns this profile.
 *
 * `wx` makes the first writer win: two runners starting together would otherwise both read an
 * unclaimed directory and both believe they own it. The loser re-reads and re-resolves.
 */
export function claimDevProfile(profileDir, repoRoot, nowMs) {
  mkdirSync(profileDir, { recursive: true })
  try {
    writeFileSync(
      path.join(profileDir, DEV_PROFILE_OWNER_FILE),
      `${JSON.stringify({ repoRoot, claimedAt: nowMs }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' }
    )
    return repoRoot
  } catch {
    return readDevProfileOwner(profileDir) ?? repoRoot
  }
}

/** Resolve the profile and record ownership, re-resolving once if another checkout claimed it first. */
export function resolveAndClaimDevUserDataProfile({
  repoRoot,
  baseDir,
  isPrimaryWorktree,
  worktreeName,
  env = process.env,
  nowMs = Date.now()
}) {
  const inputs = {
    repoRoot,
    baseDir,
    isPrimaryWorktree,
    worktreeName,
    env,
    readOwnerRepoRoot: readDevProfileOwner
  }
  const resolved = resolveDevUserDataProfile(inputs)
  if (!resolved.shouldClaim || claimDevProfile(resolved.path, repoRoot, nowMs) === repoRoot) {
    return resolved
  }
  const reResolved = resolveDevUserDataProfile(inputs)
  if (reResolved.shouldClaim) {
    claimDevProfile(reResolved.path, repoRoot, nowMs)
  }
  return reResolved
}

/**
 * Whether `repoRoot` is the repository's primary worktree.
 *
 * `git rev-parse` reports the same path for both in a primary worktree; a linked worktree's gitdir
 * is `<primary>/.git/worktrees/<name>` while its common dir stays `<primary>/.git`. A checkout with
 * no usable git (tarball, git missing) is treated as primary so it keeps the legacy behaviour.
 *
 * Both values are resolved against `repoRoot`: `--git-dir` and `--git-common-dir` answer relative to
 * the working directory, and `--path-format=absolute` is Git 2.31+, above the 2.25 baseline.
 */
export function isPrimaryWorktreePath(gitDir, gitCommonDir, repoRoot) {
  if (!gitDir || !gitCommonDir) {
    return true
  }
  return path.resolve(repoRoot, gitDir) === path.resolve(repoRoot, gitCommonDir)
}
