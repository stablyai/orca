import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readRebaseOperation } from './git-conflict-operation'
import { gitPush } from '../remote'

const tempPaths: string[] = []

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function gitIn(cwd: string) {
  return (...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** main has `main` and a conflicting `feature`; `review` is a linked worktree on `feature`. */
function createConflictingRepo(): { main: string; review: string; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-rebase-operation-')))
  tempPaths.push(root)
  const main = join(root, 'main')
  const review = join(root, 'review')
  execFileSync('git', ['init', '--quiet', main])
  const git = gitIn(main)
  // Why symbolic-ref: `init -b` needs Git 2.28.
  git('symbolic-ref', 'HEAD', 'refs/heads/main')
  git('config', 'user.name', 'Orca Test')
  git('config', 'user.email', 'orca@example.test')
  git('config', 'commit.gpgSign', 'false')
  git('config', 'core.hooksPath', '.git/no-hooks')
  writeFileSync(join(main, 'file.txt'), 'base\n')
  git('add', 'file.txt')
  git('commit', '--quiet', '-m', 'base')
  git('worktree', 'add', '--quiet', '-b', 'feature', review)
  writeFileSync(join(review, 'file.txt'), 'feature\n')
  gitIn(review)('commit', '--quiet', '-am', 'feature')
  writeFileSync(join(main, 'file.txt'), 'main\n')
  git('commit', '--quiet', '-am', 'main')
  return { main, review, root }
}

function gitAtLeast(major: number, minor: number): boolean {
  const [, maj = '0', min = '0'] =
    /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' })) ?? []
  return Number(maj) > major || (Number(maj) === major && Number(min) >= minor)
}

function pausedRebase(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['rebase', ...args], { cwd, encoding: 'utf8' })
  expect(result.status).toBe(1)
}

describe('readRebaseOperation on real Git', () => {
  it('reports a paused rebase in a linked worktree with the branch it returns to', async () => {
    const { review } = createConflictingRepo()
    pausedRebase(review, '--merge', 'main')
    await expect(readRebaseOperation(review)).resolves.toEqual({
      state: 'active',
      branch: 'refs/heads/feature'
    })
    writeFileSync(join(review, 'file.txt'), 'resolved\n')
    gitIn(review)('add', 'file.txt')
    gitIn(review)('-c', 'core.editor=true', 'rebase', '--continue')
    await expect(readRebaseOperation(review)).resolves.toEqual({
      state: 'none',
      headDetached: false
    })
  })

  // `rebase --apply` names the backend explicitly only on Git 2.26+ (2.25 used it by default).
  it.skipIf(!gitAtLeast(2, 26))(
    'reports an apply-backend rebase in the main worktree',
    async () => {
      const { main } = createConflictingRepo()
      const git = gitIn(main)
      git('worktree', 'remove', '--force', join(main, '..', 'review'))
      git('checkout', '--quiet', 'feature')
      pausedRebase(main, '--apply', 'main')
      await expect(readRebaseOperation(main)).resolves.toEqual({
        state: 'active',
        branch: 'refs/heads/feature'
      })
    }
  )

  it('keeps a detached-HEAD rebase active without a branch, and quit leaves a verified detach', async () => {
    const { review } = createConflictingRepo()
    gitIn(review)('checkout', '--quiet', '--detach')
    pausedRebase(review, '--merge', 'main')
    await expect(readRebaseOperation(review)).resolves.toEqual({ state: 'active' })
    gitIn(review)('rebase', '--quit')
    await expect(readRebaseOperation(review)).resolves.toEqual({
      state: 'none',
      headDetached: true
    })
  })

  it('does not treat git am as a rebase', async () => {
    const { main, review, root } = createConflictingRepo()
    const patchDir = join(root, 'patches')
    gitIn(review)('format-patch', '--quiet', '-1', 'HEAD', '-o', patchDir)
    const result = spawnSync('git', ['am', join(patchDir, '0001-feature.patch')], {
      cwd: main,
      encoding: 'utf8'
    })
    expect(result.status).not.toBe(0)
    await expect(readRebaseOperation(main)).resolves.toEqual({
      state: 'none',
      headDetached: false
    })
  })

  it('does not prove a detach from an empty HEAD', async () => {
    const { review } = createConflictingRepo()
    writeFileSync(join(gitIn(review)('rev-parse', '--absolute-git-dir'), 'HEAD'), '')
    await expect(readRebaseOperation(review)).resolves.toEqual({ state: 'unverifiable' })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports unreadable Git metadata as unverifiable, not as no rebase',
    async () => {
      const { review } = createConflictingRepo()
      const gitDir = gitIn(review)('rev-parse', '--absolute-git-dir')
      chmodSync(gitDir, 0o000)
      try {
        await expect(readRebaseOperation(review)).resolves.toEqual({ state: 'unverifiable' })
      } finally {
        chmodSync(gitDir, 0o755)
      }
    }
  )
})

describe('gitPush to an explicit review target', () => {
  it('refuses while a rebase is paused and leaves the remote branch untouched', async () => {
    const { main, review, root } = createConflictingRepo()
    const remote = join(root, 'remote.git')
    execFileSync('git', ['init', '--quiet', '--bare', remote])
    gitIn(main)('remote', 'add', 'fork', remote)
    gitIn(review)('push', '--quiet', 'fork', 'feature')
    const published = gitIn(remote)('rev-parse', 'refs/heads/feature')
    gitIn(review)('checkout', '--quiet', '--detach')
    pausedRebase(review, '--merge', 'main')

    await expect(
      gitPush(
        review,
        false,
        { remoteName: 'fork', branchName: 'feature' },
        { forceWithLease: true }
      )
    ).rejects.toThrow('A rebase is in progress')
    expect(gitIn(remote)('rev-parse', 'refs/heads/feature')).toBe(published)
  })
})
