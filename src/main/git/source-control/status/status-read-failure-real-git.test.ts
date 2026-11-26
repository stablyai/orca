import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { afterEach, expect, it, vi } from 'vitest'
import { getStatus } from './status-read'
import { invalidateGitReadCaches } from '../git-read-cache-invalidation'

// Real git spawns stall under gate load; the default 30s budget flakes.
vi.setConfig({ testTimeout: 120_000 })

let root: string | undefined

afterEach(async () => {
  invalidateGitReadCaches()
  if (root) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it('reports a failed status read instead of a clean tree, then recovers', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'orca-status-read-failure-'))
  const repo = path.join(root, 'repo')
  const git = (args: string[], cwd = repo): void => {
    const result = runProcessSync({ program: 'git', args, cwd })
    expect(result.code, result.stderr).toBe(0)
  }
  git(['init', '-q', repo], root)
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test User'])
  git(['config', 'commit.gpgSign', 'false'])
  await writeFile(path.join(repo, 'README.md'), 'original\n')
  git(['add', 'README.md'])
  git(['commit', '-q', '-m', 'Initial'])
  await writeFile(path.join(repo, 'README.md'), 'changed\n')

  const indexPath = path.join(repo, '.git', 'index')
  const backupPath = path.join(root, 'index.backup')
  await copyFile(indexPath, backupPath)
  await writeFile(indexPath, 'synthetic-invalid-index\n')

  const failed = await getStatus(repo, { includeLineStats: false })
  expect(failed.entries).toEqual([])
  expect(failed.readError).toMatch(/index/)

  await copyFile(backupPath, indexPath)
  invalidateGitReadCaches()
  const recovered = await getStatus(repo, { includeLineStats: false })
  expect(recovered.entries.map((entry) => entry.path)).toEqual(['README.md'])
  expect(recovered.readError).toBeUndefined()
})
