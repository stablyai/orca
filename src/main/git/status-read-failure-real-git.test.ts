import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { getStatus, invalidateGitReadCaches } from './status'

let root: string
let repo: string

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
}

beforeEach(async () => {
  invalidateGitReadCaches()
  root = await mkdtemp(path.join(tmpdir(), 'orca-status-read-failure-'))
  repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test User'])
  git(['config', 'commit.gpgSign', 'false'])
  await writeFile(path.join(repo, 'README.md'), 'original\n')
  git(['add', 'README.md'])
  git(['commit', '-q', '-m', 'Initial'])
  await writeFile(path.join(repo, 'README.md'), 'changed\n')
})

afterEach(async () => {
  invalidateGitReadCaches()
  await rm(root, { recursive: true, force: true })
})

it('reports a failed read instead of a clean tree, and recovers when Git can read again', async () => {
  const indexPath = path.join(repo, '.git', 'index')
  const backupPath = path.join(root, 'index.backup')
  await copyFile(indexPath, backupPath)
  await writeFile(indexPath, 'synthetic-invalid-index\n')

  const failed = await getStatus(repo, { includeLineStats: false })
  expect(failed.entries).toEqual([])
  expect(failed.readError).toMatch(/index/)
  expect(failed.upstreamStatus).toBeUndefined()

  await copyFile(backupPath, indexPath)
  invalidateGitReadCaches()
  const recovered = await getStatus(repo, { includeLineStats: false })
  expect(recovered.entries.map((entry) => entry.path)).toEqual(['README.md'])
  expect(recovered.readError).toBeUndefined()
})
