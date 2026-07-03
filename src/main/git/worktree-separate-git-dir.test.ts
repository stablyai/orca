import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from './runner'

// Why: spy on the git runner so we can count rev-parse invocations while still
// running real git, proving the main-entry-equals-repoPath early return skips
// the extra subprocess for an ordinary repo scanned at its own root.
const revParseTopLevelCalls = { count: 0 }
vi.mock('./runner', async () => {
  const actual = await vi.importActual<typeof GitRunner>('./runner')
  return {
    ...actual,
    gitExecFileAsync: (args: string[], options?: unknown) => {
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
        revParseTopLevelCalls.count += 1
      }
      return (actual.gitExecFileAsync as (a: string[], o?: unknown) => Promise<unknown>)(
        args,
        options
      )
    }
  }
})

// Imported after vi.mock so worktree.ts binds to the spied runner.
const { listWorktrees } = await import('./worktree')

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

async function createCommittedRepo(root: string, name: string): Promise<string> {
  const repoPath = path.join(root, name)
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  await writeFile(path.join(repoPath, 'README.md'), `${name}\n`)
  git(repoPath, ['add', 'README.md'])
  git(repoPath, ['commit', '--quiet', '-m', 'initial'])
  return realpath(repoPath)
}

async function createSeparateGitDirRepo(): Promise<{
  gitDirPath: string
  worktreePath: string
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-separate-git-dir-'))
  tempRoots.push(root)
  const sourcePath = await createCommittedRepo(root, 'source')
  const requestedWorktreePath = path.join(root, 'worktree')
  const requestedGitDirPath = path.join(root, 'git-store', 'project.git')
  await mkdir(path.dirname(requestedGitDirPath), { recursive: true })

  execFileSync('git', [
    'clone',
    '--quiet',
    `--separate-git-dir=${requestedGitDirPath}`,
    sourcePath,
    requestedWorktreePath
  ])

  return {
    gitDirPath: await realpath(requestedGitDirPath),
    worktreePath: await realpath(requestedWorktreePath)
  }
}

async function createNormalRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-normal-worktree-'))
  tempRoots.push(root)
  return createCommittedRepo(root, 'repo')
}

async function createBareRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-bare-worktree-'))
  tempRoots.push(root)
  const repoPath = path.join(root, 'repo.git')
  execFileSync('git', ['init', '--bare', '--quiet', repoPath])
  return realpath(repoPath)
}

afterEach(async () => {
  revParseTopLevelCalls.count = 0
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('git worktree separate git dir paths', () => {
  it.skipIf(process.platform === 'win32')(
    'normalizes the main worktree path for a separate-git-dir repo',
    async () => {
      const { gitDirPath, worktreePath } = await createSeparateGitDirRepo()

      const worktrees = await listWorktrees(worktreePath)
      const mainWorktree = worktrees.find((worktree) => worktree.isMainWorktree)

      expect(mainWorktree).toMatchObject({
        path: worktreePath,
        isMainWorktree: true
      })
      expect(mainWorktree?.path).not.toBe(gitDirPath)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'fires exactly one rev-parse for a separate-git-dir repo',
    async () => {
      const { worktreePath } = await createSeparateGitDirRepo()

      await listWorktrees(worktreePath)

      expect(revParseTopLevelCalls.count).toBe(1)
    }
  )

  it.skipIf(process.platform === 'win32')('leaves a normal repo main path unchanged', async () => {
    const repoPath = await createNormalRepo()

    const worktrees = await listWorktrees(repoPath)
    const mainWorktree = worktrees.find((worktree) => worktree.isMainWorktree)

    expect(mainWorktree).toMatchObject({
      path: repoPath,
      isMainWorktree: true
    })
  })

  it.skipIf(process.platform === 'win32')(
    'leaves an ordinary repo reached via a symlinked path unchanged',
    async () => {
      // A symlink alias of the checkout root defeats the path-string gate
      // (git reports the realpath toplevel), so the git-common-dir gate must
      // still skip the rewrite since the main entry is a real working root.
      const repoPath = await createNormalRepo()
      const linkRoot = await mkdtemp(path.join(tmpdir(), 'orca-symlink-worktree-'))
      tempRoots.push(linkRoot)
      const linkedRepoPath = path.join(linkRoot, 'linked-repo')
      await symlink(repoPath, linkedRepoPath)

      const worktrees = await listWorktrees(linkedRepoPath)
      const mainWorktree = worktrees.find((worktree) => worktree.isMainWorktree)

      expect(mainWorktree).toMatchObject({
        path: repoPath,
        isMainWorktree: true
      })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'leaves the main entry unchanged when scanned via a linked worktree',
    async () => {
      // A linked worktree has a `.git` *pointer file* just like a
      // separate-git-dir checkout, but its porcelain main entry is the real
      // main working root — never the Git directory. The git-common-dir gate
      // must skip the rewrite so the main entry is not overwritten with the
      // linked worktree's own toplevel (which would collide / drop the main).
      const repoPath = await createNormalRepo()
      const linkedWorktreePath = path.join(path.dirname(repoPath), 'linked')
      git(repoPath, ['worktree', 'add', '--quiet', linkedWorktreePath, '-b', 'feature'])
      const resolvedLinked = await realpath(linkedWorktreePath)

      const worktrees = await listWorktrees(resolvedLinked)
      const mainWorktree = worktrees.find((worktree) => worktree.isMainWorktree)

      expect(mainWorktree).toMatchObject({
        path: repoPath,
        isMainWorktree: true
      })
      // The main entry must not be rewritten to the linked worktree's path.
      expect(mainWorktree?.path).not.toBe(resolvedLinked)
    }
  )

  it.skipIf(process.platform === 'win32')('does not throw for a bare repo', async () => {
    const repoPath = await createBareRepo()

    const worktrees = await listWorktrees(repoPath)
    const mainWorktree = worktrees.find((worktree) => worktree.isMainWorktree)

    expect(mainWorktree).toMatchObject({
      path: repoPath,
      isBare: true,
      isMainWorktree: true
    })
  })
})
