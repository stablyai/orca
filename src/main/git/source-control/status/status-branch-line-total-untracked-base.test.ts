import { runProcess } from '@orca/process-host'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getStatus } from './status-read'

// Real git on a loaded Windows host exceeds the 30s global budget.
vi.setConfig({ testTimeout: 120_000 })
import { invalidateGitReadCaches } from '../git-read-cache-invalidation'

const roots: string[] = []

async function git(repo: string, ...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: repo })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'orca-untracked-base-total-'))
  roots.push(repo)
  await git(repo, 'init', '-q')
  await git(repo, 'config', 'user.email', 'test@example.com')
  await git(repo, 'config', 'user.name', 'Test')
  await git(repo, 'config', 'commit.gpgSign', 'false')
  await git(repo, 'commit', '--allow-empty', '-qm', 'root')
  await git(repo, 'branch', 'feature')
  await git(repo, 'checkout', '-qb', 'base')
  return repo
}

beforeEach(() => invalidateGitReadCaches())
afterEach(async () => {
  invalidateGitReadCaches()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('detects untracked overlaps with the source of a rename, including unusual filenames', async () => {
  const repo = await createRepo()
  const oldPath = process.platform === 'win32' ? 'old name.txt' : 'old\tname.txt'
  await writeFile(join(repo, oldPath), 'one\ntwo\n')
  await git(repo, 'add', oldPath)
  await git(repo, 'commit', '-qm', 'base file')
  const baseOid = await git(repo, 'rev-parse', 'HEAD')
  await git(repo, 'checkout', '-B', 'feature', 'base')
  await git(repo, 'mv', oldPath, 'renamed.txt')
  await git(repo, 'commit', '-qm', 'rename file')
  await writeFile(join(repo, oldPath), 'different\n')
  const options = { branchLineTotalMergeBase: baseOid }

  // Slow hosts exceed the 500ms branch-total soft deadline; the late diff backfills the cache for a later reuse pass.
  await getStatus(repo, options)
  await vi.waitFor(
    async () => {
      const reused = await getStatus(repo, { ...options, reuseLineStats: true })
      expect(reused.branchLineTotal).toBeUndefined()
      expect(reused.branchLineTotalUnavailable).toBe(baseOid)
    },
    { timeout: 100_000, interval: 1_000 }
  )
  await git(repo, 'add', oldPath)
  invalidateGitReadCaches()
  await vi.waitFor(
    async () => {
      expect((await getStatus(repo, options)).branchLineTotal).toMatchObject({
        added: 3,
        removed: 2
      })
    },
    { timeout: 100_000, interval: 1_000 }
  )
})
