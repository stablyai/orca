// Real-binary coverage for deferred worktree deletion: the mocked-runner suite cannot prove that Git
// accepts `worktree remove --force` on a path Orca just renamed away.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeWorktree } from './worktree'
import {
  getWorktreeTrashRoot,
  isWorktreeTrashEntryName,
  sweepStaleWorktreeTrash,
  whenWorktreeTrashDeletionsSettled,
  WORKTREE_TRASH_DIR_NAME
} from '../worktree-trash'

const execFileAsync = promisify(execFile)

let scratchDir = ''
let repoPath = ''
let workspaceRoot = ''
let worktreePath = ''

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

beforeEach(async () => {
  // realpath: macOS hands out /var/... temp paths while Git reports /private/var/..., and Orca
  // matches the worktree it is removing against Git's own list.
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-deferred-worktree-removal-')))
  repoPath = join(scratchDir, 'repo')
  workspaceRoot = join(scratchDir, 'workspaces')
  worktreePath = join(workspaceRoot, 'repo', 'feature')
  await mkdir(repoPath, { recursive: true })
  await mkdir(join(workspaceRoot, 'repo'), { recursive: true })
  await git(['init', '-q'], repoPath)
  await git(['config', 'user.email', 'deferred@example.invalid'], repoPath)
  await git(['config', 'user.name', 'Deferred Removal'], repoPath)
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  // Committed before the worktree exists so its branch stays merged and branch cleanup can run.
  await mkdir(join(repoPath, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(repoPath, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  await git(['add', '-A'], repoPath)
  await git(['commit', '-qm', 'seed'], repoPath)
  await git(['worktree', 'add', '-q', worktreePath, '-b', 'feature'], repoPath)
})

afterEach(async () => {
  await whenWorktreeTrashDeletionsSettled()
  await rm(scratchDir, { recursive: true, force: true })
})

describe('deferred worktree removal against the real Git binary', () => {
  it('clears the registration and deletes the renamed checkout in the background', async () => {
    const trashRoot = getWorktreeTrashRoot(worktreePath)

    await removeWorktree(repoPath, worktreePath, false, { deleteBranch: false })

    // The user-visible removal is complete: nothing on disk, nothing registered.
    expect(existsSync(worktreePath)).toBe(false)
    expect(await git(['worktree', 'list'], repoPath)).not.toContain(worktreePath)
    // Only the rename path creates this root, so its presence proves the deletion was deferred.
    expect(existsSync(trashRoot)).toBe(true)
    expect((await readdir(trashRoot)).every(isWorktreeTrashEntryName)).toBe(true)

    await whenWorktreeTrashDeletionsSettled()
    expect(await readdir(trashRoot)).toEqual([])
  })

  it('leaves sibling worktrees registered', async () => {
    const siblingPath = join(workspaceRoot, 'repo', 'sibling')
    await git(['worktree', 'add', '-q', siblingPath, '-b', 'sibling'], repoPath)

    await removeWorktree(repoPath, worktreePath, false, { deleteBranch: false })

    expect(await git(['worktree', 'list'], repoPath)).toContain(siblingPath)
    expect(existsSync(siblingPath)).toBe(true)
  })

  it('deletes the branch exactly as the in-place removal did', async () => {
    await removeWorktree(repoPath, worktreePath, false)

    expect(await git(['branch', '--list', 'feature'], repoPath)).toBe('')
  })

  it('refuses to move a dirty checkout aside', async () => {
    await writeFile(join(worktreePath, 'seed.txt'), 'edited\n')

    await expect(removeWorktree(repoPath, worktreePath, false)).rejects.toThrow()
    expect(existsSync(join(worktreePath, 'seed.txt'))).toBe(true)
    expect(await git(['worktree', 'list'], repoPath)).toContain(worktreePath)
    expect(existsSync(getWorktreeTrashRoot(worktreePath))).toBe(false)
  })

  it('sweeps trash a previous run left behind', async () => {
    const stalePath = join(
      workspaceRoot,
      'repo',
      WORKTREE_TRASH_DIR_NAME,
      'wt-1700000000000-deadbeef'
    )
    await mkdir(join(stalePath, 'node_modules'), { recursive: true })

    await sweepStaleWorktreeTrash([workspaceRoot])

    expect(existsSync(stalePath)).toBe(false)
    expect(existsSync(worktreePath)).toBe(true)
  })
})
