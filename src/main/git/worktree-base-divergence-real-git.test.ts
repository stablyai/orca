import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  measureRetargetDivergence,
  RETARGET_MAX_COMMIT_DIVERGENCE
} from './worktree-base-divergence'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

async function createRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-base-divergence-'))
  tempRoots.push(root)
  const repoPath = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  await writeFile(join(repoPath, 'version.txt'), 'one\n')
  git(repoPath, ['add', 'version.txt'])
  git(repoPath, ['commit', '--quiet', '-m', 'initial'])
  return repoPath
}

// Why unique across calls: an empty commit's hash covers only parent, tree, message and a
// one-second-granularity timestamp. On a fast runner the whole 100-commit build finishes inside
// one second, so a post-reset `commit 0` off the same fork point hashed identically to the first
// `commit 0` of the chain and Git handed back that same object — leaving the branch 99/0 apart
// instead of 100/1.
let emptyCommitSequence = 0

function commitEmpty(repoPath: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    emptyCommitSequence += 1
    git(repoPath, ['commit', '--quiet', '--allow-empty', '-m', `commit ${emptyCommitSequence}`])
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('measureRetargetDivergence with real Git', () => {
  it('allows the drift between a local branch and its remote-tracking copy', async () => {
    const repoPath = await createRepo()
    git(repoPath, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    commitEmpty(repoPath, 5)
    git(repoPath, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    git(repoPath, ['reset', '--hard', '--quiet', 'HEAD~3'])

    await expect(
      measureRetargetDivergence(repoPath, 'refs/heads/main', 'refs/remotes/origin/main')
    ).resolves.toBe('within')
  })

  it('counts drift in both directions', async () => {
    const repoPath = await createRepo()
    const forkPoint = git(repoPath, ['rev-parse', 'HEAD'])
    commitEmpty(repoPath, RETARGET_MAX_COMMIT_DIVERGENCE)
    git(repoPath, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    git(repoPath, ['reset', '--hard', '--quiet', forkPoint])
    commitEmpty(repoPath, 1)

    // 100 ahead + 1 behind is over the cap even though neither side alone exceeds it.
    await expect(
      measureRetargetDivergence(repoPath, 'refs/heads/main', 'refs/remotes/origin/main')
    ).resolves.toBe('exceeded')
  })

  it('refuses a base that has drifted past the cap', async () => {
    const repoPath = await createRepo()
    git(repoPath, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    commitEmpty(repoPath, RETARGET_MAX_COMMIT_DIVERGENCE + 1)

    await expect(
      measureRetargetDivergence(repoPath, 'refs/remotes/origin/main', 'refs/heads/main')
    ).resolves.toBe('exceeded')
  })

  it('refuses unrelated histories, which share no commits at all', async () => {
    const repoPath = await createRepo()
    git(repoPath, ['checkout', '--quiet', '--orphan', 'unrelated'])
    git(repoPath, ['commit', '--quiet', '--allow-empty', '-m', 'unrelated root'])

    await expect(
      measureRetargetDivergence(repoPath, 'refs/heads/main', 'refs/heads/unrelated')
    ).resolves.toBe('exceeded')
  })

  it('reports an unreadable ref as unverifiable, not as excess drift', async () => {
    const repoPath = await createRepo()

    await expect(
      measureRetargetDivergence(repoPath, 'refs/heads/main', 'refs/heads/missing')
    ).resolves.toBe('unknown')
  })
})
