import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invalidateGitBranchLineTotalInFlight } from '../../../../shared/git/status/git-branch-line-total'

import { clearEffectiveUpstreamStatusCacheForTests } from '../upstream/effective-upstream-status-cache'
import { clearSubmodulePathsCacheForTests } from '../submodules/submodule-paths'
import { getStatus } from './status-read'
import { invalidateGitReadCaches } from '../git-read-cache-invalidation'

const tempRoots: string[] = []

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

async function createFixtureRepo(): Promise<{ repo: string; mergeBase: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-branch-line-total-exec-'))
  tempRoots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  git(repo, ['config', 'commit.gpgSign', 'false'])
  await write(repo, 'f.txt', 'a\nb\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'base'])
  await write(repo, 'f.txt', 'a\nb\nc\n')
  return { repo, mergeBase: git(repo, ['rev-parse', 'HEAD']) }
}

async function write(repo: string, relativePath: string, contents: string): Promise<void> {
  const target = path.join(repo, relativePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, contents)
}

function resetGitReadCaches(): void {
  clearEffectiveUpstreamStatusCacheForTests()
  clearSubmodulePathsCacheForTests()
  invalidateGitReadCaches()
  invalidateGitBranchLineTotalInFlight()
}

beforeEach(() => {
  resetGitReadCaches()
})

afterEach(async () => {
  resetGitReadCaches()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('branch line total completeness', () => {
  it('omits the total when the status listing hit its limit', async () => {
    const { repo, mergeBase } = await createFixtureRepo()
    await write(repo, 'u1.txt', 'a\n')
    await write(repo, 'u2.txt', 'b\n')
    await write(repo, 'u3.txt', 'c\n')

    const result = await getStatus(repo, { branchLineTotalMergeBase: mergeBase, limit: 1 })

    expect(result.didHitLimit).toBe(true)
    expect(result.branchLineTotal).toBeUndefined()
    expect(result.branchLineTotalUnavailable).toBeUndefined()
  })
})
