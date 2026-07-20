import { existsSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import * as path from 'path'

const WORKSPACE_BRANCH = 'gitbutler/workspace'
// Legacy name GitButler used before renaming the integration branch to workspace.
const LEGACY_INTEGRATION_BRANCH = 'gitbutler/integration'
const REFS_HEADS_PREFIX = 'refs/heads/'

function stripRefsHeads(branch: string): string {
  return branch.startsWith(REFS_HEADS_PREFIX) ? branch.slice(REFS_HEADS_PREFIX.length) : branch
}

/**
 * Resolve the repository's COMMON git dir from a worktree's resolved git dir.
 * Why: `resolveGitDir` returns the per-worktree dir for linked worktrees
 * (`<common>/.git/worktrees/<name>`), but GitButler stores its metadata in the
 * common dir. Git writes a `commondir` file inside every linked-worktree dir
 * pointing (usually relatively) at the common dir; when present, resolve it.
 * Otherwise the resolved dir already IS the common dir (normal checkout).
 */
async function resolveCommonGitDir(resolvedGitDir: string): Promise<string> {
  const commonDirPointer = path.join(resolvedGitDir, 'commondir')
  if (!existsSync(commonDirPointer)) {
    return resolvedGitDir
  }
  try {
    const contents = (await readFile(commonDirPointer, 'utf-8')).trim()
    return path.resolve(resolvedGitDir, contents)
  } catch {
    return resolvedGitDir
  }
}

/**
 * Detect whether a worktree is sitting on an active GitButler workspace.
 *
 * Why both conditions (AND, never OR): requiring the workspace branch name AND
 * the `gitbutler/` metadata avoids two distinct false positives — a branch
 * coincidentally named `gitbutler/workspace` without GitButler, and stale
 * `gitbutler/` metadata while the user has a normal branch checked out (Orca's
 * git actions are not hitting the synthetic branch in either case).
 *
 * The filesystem probe is GATED behind the branch-name check so normal repos
 * pay nothing — no git-dir resolution and no `existsSync` runs unless the
 * branch matches.
 */
export async function detectGitButlerWorkspace(
  worktreePath: string,
  branch: string | undefined | null,
  resolveGitDir: (worktreePath: string) => Promise<string>
): Promise<boolean> {
  if (!branch) {
    return false
  }
  const shortBranch = stripRefsHeads(branch)
  if (shortBranch !== WORKSPACE_BRANCH && shortBranch !== LEGACY_INTEGRATION_BRANCH) {
    return false
  }

  const resolvedGitDir = await resolveGitDir(worktreePath)
  const commonGitDir = await resolveCommonGitDir(resolvedGitDir)
  return await isDirectory(path.join(commonGitDir, 'gitbutler'))
}

// Why: GitButler stores its metadata as a directory; an unrelated regular file
// named `gitbutler` must not count as a match (existsSync alone accepts both).
async function isDirectory(target: string): Promise<boolean> {
  if (!existsSync(target)) {
    return false
  }
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}
