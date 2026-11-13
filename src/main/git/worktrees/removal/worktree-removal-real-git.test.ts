// Real Git verifies deletion/refusal behavior.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installRealWorkerThreadChildProcesses } from '../../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { removeTree } from '../../../../shared/windows-transient-lock-removal'

import { listWorktreesStrict } from '../catalog/worktree-listing'
import { removeWorktree } from './worktree-removal'
import { areWorktreePathsEqual } from '../catalog/worktree-path-comparison'
import { isPrunableGitFileWorktree } from '../../../workspaces/removal/worktree-prunable-git-file'
import { removeStaleLocalWorktreeRegistration } from '../../../workspaces/removal/local-worktree-removal-recovery'
import {
  sweepStaleWorktreeTrash,
  WORKTREE_TRASH_DIR_NAME
} from '../../../workspaces/removal/worktree-trash'

const execFileAsync = promisify(execFile)

installRealWorkerThreadChildProcesses()

let scratchDir = ''
let repoPath = ''
let workspaceRoot = ''
let worktreePath = ''

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

// Git prints forward slashes on Windows, so compare parsed paths.
async function isRegistered(path: string): Promise<boolean> {
  return (await listWorktreesStrict(repoPath)).some((worktree) =>
    areWorktreePathsEqual(worktree.path, path)
  )
}

beforeEach(async () => {
  // Canonicalize macOS /var temp paths to match Git's /private/var output.
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-worktree-removal-')))
  repoPath = join(scratchDir, 'repo')
  workspaceRoot = join(scratchDir, 'workspaces')
  worktreePath = join(workspaceRoot, 'repo', 'feature')
  await mkdir(repoPath, { recursive: true })
  await mkdir(join(workspaceRoot, 'repo'), { recursive: true })
  await git(['init', '-q'], repoPath)
  await git(['config', 'user.email', 'removal@example.invalid'], repoPath)
  await git(['config', 'user.name', 'Worktree Removal'], repoPath)
  // Disable detached maintenance that could race fixture teardown.
  await git(['config', 'maintenance.auto', 'false'], repoPath)
  await git(['config', 'gc.auto', '0'], repoPath)
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  // Committed before the worktree exists so its branch stays merged and branch cleanup can run.
  await mkdir(join(repoPath, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(repoPath, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  await git(['add', '-A'], repoPath)
  await git(['commit', '-qm', 'seed'], repoPath)
  await git(['worktree', 'add', '-q', worktreePath, '-b', 'feature'], repoPath)
})

afterEach(async () => {
  await removeTree(scratchDir)
})

describe('worktree removal against the real Git binary', () => {
  it('preserves a branch whose only unmerged commit is empty', async () => {
    await git(['commit', '--allow-empty', '-qm', 'unique empty commit'], worktreePath)
    const head = (await git(['rev-parse', 'HEAD'], worktreePath)).trim()

    const result = await removeWorktree(repoPath, worktreePath, false)

    expect(existsSync(worktreePath)).toBe(false)
    expect(await isRegistered(worktreePath)).toBe(false)
    expect(result).toEqual({ preservedBranch: { branchName: 'feature', head } })
    expect((await git(['rev-parse', 'refs/heads/feature'], repoPath)).trim()).toBe(head)
  })

  it('preserves unmerged commits that cancel out their file changes', async () => {
    await writeFile(join(worktreePath, 'seed.txt'), 'temporary change\n')
    await git(['commit', '-qam', 'change seed'], worktreePath)
    await git(['revert', '--no-edit', 'HEAD'], worktreePath)
    const head = (await git(['rev-parse', 'HEAD'], worktreePath)).trim()

    const result = await removeWorktree(repoPath, worktreePath, false)

    expect(result).toEqual({ preservedBranch: { branchName: 'feature', head } })
    expect((await git(['rev-parse', 'refs/heads/feature'], repoPath)).trim()).toBe(head)
  })

  it('still deletes a squash-merged branch with net file changes', async () => {
    await writeFile(join(worktreePath, 'seed.txt'), 'feature change\n')
    await git(['commit', '-qam', 'change seed'], worktreePath)
    await git(['merge', '--squash', 'feature'], repoPath)
    await git(['commit', '-qm', 'squash feature'], repoPath)

    expect(await removeWorktree(repoPath, worktreePath, false)).toEqual({})
    expect(await git(['branch', '--list', 'feature'], repoPath)).toBe('')
  })

  async function addSubmoduleCheckoutWithLocalCommit(): Promise<{
    subWorktreePath: string
    vendorPath: string
    localCommit: string
  }> {
    const emptyCommit = ['-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit']
    const originPath = join(scratchDir, 'origin')
    await mkdir(originPath)
    await git(['init', '-q'], originPath)
    await git([...emptyCommit, '-q', '--allow-empty', '-m', 'origin'], originPath)
    await git(
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', originPath, 'vendor'],
      repoPath
    )
    await git(['commit', '-qm', 'add vendor'], repoPath)
    const subWorktreePath = join(workspaceRoot, 'repo', 'with-sub')
    await git(['worktree', 'add', '-q', subWorktreePath, '-b', 'with-sub'], repoPath)
    await git(
      ['-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init'],
      subWorktreePath
    )
    const vendorPath = join(subWorktreePath, 'vendor')
    await git([...emptyCommit, '-q', '--allow-empty', '-m', 'local only'], vendorPath)
    const localCommit = (await git(['rev-parse', 'HEAD'], vendorPath)).trim()
    return { subWorktreePath, vendorPath, localCommit }
  }

  it('preserves a submodule commit until forced deletion', async () => {
    // Force deletion can destroy submodule-only commits; preserve Git's refusal.
    const { subWorktreePath, vendorPath, localCommit } = await addSubmoduleCheckoutWithLocalCommit()
    // Recorded by the parent so its status stays clean.
    await git(['commit', '-qam', 'bump vendor'], subWorktreePath)

    const refusal = await removeWorktree(repoPath, subWorktreePath, false).catch((error) => error)
    expect(refusal).toBeInstanceOf(Error)
    expect(await isRegistered(subWorktreePath)).toBe(true)
    expect((await git(['cat-file', '-t', localCommit], vendorPath)).trim()).toBe('commit')

    await removeWorktree(repoPath, subWorktreePath, true)
    expect(await isRegistered(subWorktreePath)).toBe(false)
  })

  it('prunes a proven malformed registration while retaining checkout files and its branch', async () => {
    const markerPath = join(worktreePath, '.git')
    const marker = await readFile(markerPath, 'utf8')
    const adminPath = marker.trim().replace(/^gitdir: /, '')
    await writeFile(join(adminPath, 'gitdir'), `${join(markerPath, '.git')}\n`)
    await writeFile(join(worktreePath, 'untracked.txt'), 'keep this work\n')
    const row = (await listWorktreesStrict(repoPath)).find((entry) =>
      areWorktreePathsEqual(entry.path, markerPath)
    )
    if (!row) {
      throw new Error('Missing malformed registration')
    }
    expect(await isPrunableGitFileWorktree(row)).toBe(true)

    const result = await removeStaleLocalWorktreeRegistration({
      canonicalWorktreePath: row.path,
      repoPath,
      localWorktreeGitOptions: {},
      registeredWorktree: row,
      deleteBranch: true
    })

    expect(result).toEqual({ preservedBranch: { branchName: 'feature', head: row.head } })
    expect(await readFile(markerPath, 'utf8')).toBe(marker)
    expect(await readFile(join(worktreePath, 'untracked.txt'), 'utf8')).toBe('keep this work\n')
    expect(await git(['rev-parse', 'refs/heads/feature'], repoPath)).toBe(`${row.head}\n`)
    expect(await isRegistered(markerPath)).toBe(false)
    expect(existsSync(adminPath)).toBe(false)
  })

  it('sweeps trash an older release left behind', async () => {
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
