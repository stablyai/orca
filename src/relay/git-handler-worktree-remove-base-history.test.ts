// Real-binary coverage: SSH workspaces are cut with `--no-track` too, so `-d` compares against the
// main checkout's HEAD and refuses branches whose base already holds their head.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import type { GitHandler } from './git-handler'
import { gitInit, gitCommit, type MockDispatcher } from './git-handler-test-setup'
import {
  createGitHandlerRelay,
  createGitTempDir,
  removeGitTempDir
} from './git-handler-test-harness'

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim()
}

describe('relay removal of a branch whose base already holds its head', () => {
  let dispatcher: MockDispatcher
  let handler: GitHandler
  let scratchDir: string
  let repoPath: string

  function addWorkspace(name: string, base: string): string {
    const worktreePath = path.join(scratchDir, name)
    git(['worktree', 'add', '-q', '--no-track', '-b', name, worktreePath, base], repoPath)
    git(['config', `branch.${name}.base`, base], repoPath)
    return worktreePath
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    scratchDir = realpathSync(createGitTempDir())
    repoPath = path.join(scratchDir, 'repo')
    mkdirSync(repoPath)
    gitInit(repoPath)
    writeFileSync(path.join(repoPath, 'seed.txt'), 'seed\n')
    gitCommit(repoPath, 'seed')
    git(['branch', '-M', 'main'], repoPath)
    const originPath = path.join(scratchDir, 'origin.git')
    git(['init', '-q', '--bare', originPath], scratchDir)
    git(['remote', 'add', 'origin', originPath], repoPath)
    // Someone's open review branch, fetched but never checked out here.
    git(['checkout', '-q', '-b', 'author-work'], repoPath)
    writeFileSync(path.join(repoPath, 'feature.txt'), 'feature\n')
    gitCommit(repoPath, 'feature')
    git(['push', '-q', 'origin', 'author-work:feature-x', 'main:main'], repoPath)
    git(['checkout', '-q', 'main'], repoPath)
    git(['branch', '-D', 'author-work'], repoPath)
    git(['fetch', '-q', 'origin'], repoPath)
    ;({ dispatcher, handler } = createGitHandlerRelay())
  })

  afterEach(async () => {
    handler.dispose()
    vi.restoreAllMocks()
    await removeGitTempDir(scratchDir)
  })

  it("deletes a workspace opened on someone's review branch with no commits", async () => {
    const worktreePath = addWorkspace('feature-x', 'refs/remotes/origin/feature-x')

    await expect(dispatcher.callRequest('git.removeWorktree', { worktreePath })).resolves.toEqual(
      {}
    )
    expect(git(['branch', '--list', 'feature-x'], repoPath)).toBe('')
  })

  it('keeps a workspace with a commit its base does not hold', async () => {
    const worktreePath = addWorkspace('unpushed', 'refs/remotes/origin/feature-x')
    writeFileSync(path.join(worktreePath, 'unpushed.txt'), 'unpushed\n')
    gitCommit(worktreePath, 'unpushed')
    const head = git(['rev-parse', 'HEAD'], worktreePath)

    await expect(dispatcher.callRequest('git.removeWorktree', { worktreePath })).resolves.toEqual({
      preservedBranch: { branchName: 'unpushed', head }
    })
    expect(git(['rev-parse', 'refs/heads/unpushed'], repoPath)).toBe(head)
  })
})

// Why: a bare repo's HEAD names a branch without checking it out, so the base check must not count
// the branch as its own base.
describe('relay removal of the branch HEAD names in a .bare layout', () => {
  let dispatcher: MockDispatcher
  let handler: GitHandler
  let scratchDir: string

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    scratchDir = realpathSync(createGitTempDir())
    ;({ dispatcher, handler } = createGitHandlerRelay())
  })

  afterEach(async () => {
    handler.dispose()
    vi.restoreAllMocks()
    await removeGitTempDir(scratchDir)
  })

  it('keeps it when it has a commit its upstream does not', async () => {
    const seedPath = path.join(scratchDir, 'seed')
    mkdirSync(seedPath)
    gitInit(seedPath)
    writeFileSync(path.join(seedPath, 'seed.txt'), 'seed\n')
    gitCommit(seedPath, 'seed')
    const originPath = path.join(scratchDir, 'origin.git')
    git(['init', '-q', '--bare', originPath], scratchDir)
    git(['push', '-q', originPath, 'HEAD:refs/heads/main'], seedPath)
    const projectPath = path.join(scratchDir, 'project')
    git(['clone', '-q', '--bare', originPath, path.join(projectPath, '.bare')], scratchDir)
    writeFileSync(path.join(projectPath, '.git'), 'gitdir: ./.bare\n')
    git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], projectPath)
    git(['fetch', '-q', 'origin'], projectPath)
    git(['branch', '-q', '-u', 'origin/main', 'main'], projectPath)
    const worktreePath = path.join(scratchDir, 'main-checkout')
    git(['worktree', 'add', '-q', worktreePath, 'main'], projectPath)
    writeFileSync(path.join(worktreePath, 'unpushed.txt'), 'unpushed\n')
    gitCommit(worktreePath, 'unpushed')
    const head = git(['rev-parse', 'HEAD'], worktreePath)

    await expect(dispatcher.callRequest('git.removeWorktree', { worktreePath })).resolves.toEqual({
      preservedBranch: { branchName: 'main', head }
    })
    expect(git(['rev-parse', 'refs/heads/main'], projectPath)).toBe(head)
  })
})
