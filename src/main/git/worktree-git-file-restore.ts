import { readdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { GitWorktreeExecOptions } from './worktree-operation-options'
import { getErrorCode } from './worktree-operation-options'
import { readRepoCommonDirFromGit } from './worktree-list-reader'
import { areWorktreePathsEqual } from './worktree-path-comparison'

/**
 * Rewrites a registered linked worktree's missing `.git` file from Git's own admin entry, the one
 * whose `gitdir` points back at it, so `git worktree remove` can validate and delete the checkout.
 *
 * Why not `git worktree repair` (2.29+): it also re-points every other registered path's `.git`,
 * including a checkout another repository now owns at a reused path.
 */
export async function restoreMissingWorktreeGitFile(
  repoPath: string,
  worktreePath: string,
  options: GitWorktreeExecOptions = {}
): Promise<boolean> {
  const commonDir = await readRepoCommonDirFromGit(repoPath, options)
  if (!commonDir) {
    return false
  }
  const adminRoot = join(commonDir, 'worktrees')
  let entryNames: string[]
  try {
    entryNames = (await readdir(adminRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return false
  }
  const gitFilePath = join(worktreePath, '.git')
  const owners: string[] = []
  for (const name of entryNames) {
    const entryDir = join(adminRoot, name)
    const backlink = await readFile(join(entryDir, 'gitdir'), 'utf8').then(
      (content) => content.trim(),
      () => ''
    )
    const resolved = backlink && (isAbsolute(backlink) ? backlink : join(entryDir, backlink))
    if (resolved && areWorktreePathsEqual(resolved, gitFilePath)) {
      owners.push(entryDir)
    }
  }
  if (owners.length !== 1) {
    return false
  }
  // Forward slashes are what Git itself writes, and what it compares against on Windows.
  const adminDir = process.platform === 'win32' ? owners[0].replaceAll('\\', '/') : owners[0]
  try {
    await writeFile(gitFilePath, `gitdir: ${adminDir}\n`, { flag: 'wx' })
  } catch (error) {
    // Something recreated `.git` meanwhile; Git's own validation judges it.
    return getErrorCode(error) === 'EEXIST'
  }
  return true
}
