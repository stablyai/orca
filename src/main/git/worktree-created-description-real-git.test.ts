// Real Git verifies that fallback description matches worktree list output.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearGitCapabilityStateForTests, getLocalGitCapabilityCache } from './git-capability-state'
import { describeCreatedWorktree, listWorktreesStrict } from './worktree'

const execFileAsync = promisify(execFile)

let scratchDir = ''
let repoPath = ''
let worktreePath = ''

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

async function seedRepo(path: string, email: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await git(['init', '-q'], path)
  await git(['config', 'user.email', email], path)
  await git(['config', 'user.name', 'Created Description'], path)
  await writeFile(join(path, 'seed.txt'), 'seed\n')
  await git(['add', '-A'], path)
  await git(['commit', '-qm', 'seed'], path)
}

beforeEach(async () => {
  // realpath: macOS hands out /var/... temp paths while Git reports /private/var/...
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-created-worktree-')))
  repoPath = join(scratchDir, 'repo')
  worktreePath = join(scratchDir, 'workspaces', 'feature')
  await seedRepo(repoPath, 'created@example.invalid')
  await git(['worktree', 'add', '-q', worktreePath, '-b', 'feature'], repoPath)
})

afterEach(async () => {
  clearGitCapabilityStateForTests()
  await rm(scratchDir, { recursive: true, force: true })
})

describe('describeCreatedWorktree against the real Git binary', () => {
  it('rebuilds exactly the row the listing reports for the same worktree', async () => {
    const listed = (await listWorktreesStrict(repoPath)).find(
      (worktree) => worktree.branch === 'refs/heads/feature'
    )
    expect(listed).toBeDefined()

    await expect(describeCreatedWorktree(repoPath, worktreePath, 'feature')).resolves.toEqual(
      listed
    )
  })

  it('rejects a checkout owned by a different repo', async () => {
    const otherRepo = join(scratchDir, 'other')
    await seedRepo(otherRepo, 'other@example.invalid')

    await expect(
      describeCreatedWorktree(otherRepo, worktreePath, 'feature')
    ).resolves.toBeUndefined()
  })

  it('rejects a detached HEAD', async () => {
    await git(['checkout', '-q', '--detach'], worktreePath)

    await expect(
      describeCreatedWorktree(repoPath, worktreePath, 'feature')
    ).resolves.toBeUndefined()
  })

  it('rejects a worktree whose HEAD Git cannot resolve', async () => {
    // Deleting the branch ref leaves HEAD symbolic but unborn: the ref check still passes.
    await rm(join(repoPath, '.git', 'refs', 'heads', 'feature'))

    await expect(
      describeCreatedWorktree(repoPath, worktreePath, 'feature')
    ).resolves.toBeUndefined()
  })

  it('rejects a path that is not a worktree', async () => {
    const plainDir = join(scratchDir, 'not-a-worktree')
    await mkdir(plainDir, { recursive: true })

    await expect(describeCreatedWorktree(repoPath, plainDir, 'feature')).resolves.toBeUndefined()
  })

  // `ln` is absent from the Windows test PATH.
  it.skipIf(process.platform === 'win32')(
    'still recovers when the repo root reaches Git through a symlink',
    async () => {
      const linkedRepo = join(scratchDir, 'repo-link')
      await execFileAsync('ln', ['-s', repoPath, linkedRepo])

      // Canonicalize both common dirs so symlinked repo roots can confirm ownership.
      await expect(
        describeCreatedWorktree(linkedRepo, worktreePath, 'feature')
      ).resolves.toMatchObject({ branch: 'refs/heads/feature' })
    }
  )

  // `mkfifo` stands in for a `.git` on a hung mount: the read never rejects on its own.
  it.skipIf(process.platform === 'win32')(
    "settles with the unread witness named when the repo's .git blocks forever",
    async () => {
      const stalledRepo = join(scratchDir, 'stalled')
      await mkdir(stalledRepo, { recursive: true })
      const stalledDotGit = join(stalledRepo, '.git')
      await execFileAsync('mkfifo', [stalledDotGit])
      try {
        // Unread witnesses prove neither a foreign repo nor an absent worktree; retain the diagnostic.
        const settledBy = Date.now() + 5_000
        await expect(
          describeCreatedWorktree(stalledRepo, worktreePath, 'feature', { timeout: 250 })
        ).rejects.toThrow(/^repo common dir unverifiable: could not read .*\.git: /)
        expect(Date.now()).toBeLessThan(settledBy)
      } finally {
        // Release the pending read so the fifo does not pin a threadpool thread for the whole run.
        await writeFile(stalledDotGit, '')
      }
    }
  )

  it('recovers a worktree created from a bare repo', async () => {
    const bareRepo = join(scratchDir, 'bare.git')
    await execFileAsync('git', ['clone', '-q', '--bare', repoPath, bareRepo])
    const bareWorktree = join(scratchDir, 'workspaces', 'from-bare')
    await git(['worktree', 'add', '-q', bareWorktree, '-b', 'from-bare'], bareRepo)

    // Bare repos lack .git markers, so only Git can confirm common-dir ownership.
    await expect(
      describeCreatedWorktree(bareRepo, bareWorktree, 'from-bare')
    ).resolves.toMatchObject({ branch: 'refs/heads/from-bare', isMainWorktree: false })
  })

  it('recovers on the Git 2.25 baseline, which ignores --path-format=absolute', async () => {
    // Force relative-path capability fallback against the real binary.
    getLocalGitCapabilityCache({ cwd: repoPath }).rememberUnsupported('rev-parse-path-format')
    const listed = (await listWorktreesStrict(repoPath)).find(
      (worktree) => worktree.branch === 'refs/heads/feature'
    )

    await expect(describeCreatedWorktree(repoPath, worktreePath, 'feature')).resolves.toEqual(
      listed
    )
  })

  // `ln` is absent from the Windows test PATH.
  it.skipIf(process.platform === 'win32')(
    'recovers a symlinked root on the Git 2.25 baseline',
    async () => {
      const linkedRepo = join(scratchDir, 'repo-link')
      await execFileAsync('ln', ['-s', repoPath, linkedRepo])
      getLocalGitCapabilityCache({ cwd: linkedRepo }).rememberUnsupported('rev-parse-path-format')

      // Canonicalize caller symlink and real-root spellings before comparing object stores.
      await expect(
        describeCreatedWorktree(linkedRepo, worktreePath, 'feature')
      ).resolves.toMatchObject({ branch: 'refs/heads/feature' })
    }
  )
})
