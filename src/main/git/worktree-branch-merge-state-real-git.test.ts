// Real-binary coverage: auto-close hinges on Git agreeing a branch landed, and a mocked runner
// cannot prove the squash-merge path (patch-id + merge-tree) reaches the same verdict.
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  hasWorktreeBranchUpstreamConfigured,
  isWorktreeBranchMergedIntoBase
} from './worktree-branch-merge-state'

const execFileAsync = promisify(execFile)

let repoPath = ''

async function git(args: string[], cwd = repoPath): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

async function commit(fileName: string, contents: string): Promise<void> {
  await writeFile(join(repoPath, fileName), contents)
  await git(['add', '-A'])
  await git(['commit', '-qm', `add ${fileName}`])
}

beforeEach(async () => {
  repoPath = await realpath(await mkdtemp(join(tmpdir(), 'orca-branch-merge-state-')))
  await git(['init', '-q'])
  // symbolic-ref rather than `init -b`: the latter needs Git 2.28, above the supported floor.
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await git(['config', 'user.email', 'merge-state@example.invalid'])
  await git(['config', 'user.name', 'Merge State'])
  await commit('seed.txt', 'seed\n')
})

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true })
})

describe('isWorktreeBranchMergedIntoBase', () => {
  it('reports a fast-forward-merged branch as merged', async () => {
    await git(['checkout', '-q', '-b', 'feature'])
    await commit('feature.txt', 'feature\n')
    await git(['checkout', '-q', 'main'])
    await git(['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature'])

    await expect(isWorktreeBranchMergedIntoBase(repoPath, 'feature')).resolves.toBe(true)
  })

  it('reports a squash-merged branch as merged even though its commits are rewritten', async () => {
    await git(['checkout', '-q', '-b', 'squashed'])
    await commit('one.txt', 'one\n')
    await commit('two.txt', 'two\n')
    await git(['checkout', '-q', 'main'])
    await git(['merge', '-q', '--squash', 'squashed'])
    await git(['commit', '-qm', 'squash squashed'])

    await expect(isWorktreeBranchMergedIntoBase(repoPath, 'squashed')).resolves.toBe(true)
  })

  it('reports an unmerged branch as unmerged', async () => {
    await git(['checkout', '-q', '-b', 'pending'])
    await commit('pending.txt', 'pending\n')
    await git(['checkout', '-q', 'main'])

    await expect(isWorktreeBranchMergedIntoBase(repoPath, 'pending')).resolves.toBe(false)
  })

  it('resolves null for a branch Git does not know', async () => {
    await expect(isWorktreeBranchMergedIntoBase(repoPath, 'missing')).resolves.toBe(false)
    await expect(isWorktreeBranchMergedIntoBase(repoPath, '')).resolves.toBeNull()
  })
})

describe('hasWorktreeBranchUpstreamConfigured', () => {
  it('is false for a local-only branch and true once an upstream is configured', async () => {
    await git(['checkout', '-q', '-b', 'local-only'])

    await expect(hasWorktreeBranchUpstreamConfigured(repoPath, 'local-only')).resolves.toBe(false)

    await git(['config', 'branch.local-only.remote', 'origin'])
    await git(['config', 'branch.local-only.merge', 'refs/heads/local-only'])

    await expect(hasWorktreeBranchUpstreamConfigured(repoPath, 'local-only')).resolves.toBe(true)
  })

  it('stays true after the remote branch itself is gone, which is the post-merge state', async () => {
    await git(['checkout', '-q', '-b', 'landed'])
    await git(['config', 'branch.landed.remote', 'origin'])
    await git(['config', 'branch.landed.merge', 'refs/heads/landed'])

    // No refs/remotes/origin/landed exists here — exactly what a merged-and-pruned PR leaves behind.
    await expect(hasWorktreeBranchUpstreamConfigured(repoPath, 'landed')).resolves.toBe(true)
  })
})
