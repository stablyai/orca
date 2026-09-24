import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitExecFileAsync } from './runner'
import {
  countCommitsNotOnRef,
  countUniqueCommitsAgainstDefaultBranch,
  resetDefaultBranchUniqueCommitCacheForTests
} from './default-branch-unique-commit-count'

const roots: string[] = []

afterEach(async () => {
  resetDefaultBranchUniqueCommitCacheForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-default-contained-'))
  roots.push(root)
  const repo = join(root, 'repo')
  await gitExecFileAsync(['init', '--quiet', repo], { cwd: root })
  await gitExecFileAsync(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo })
  await writeFile(join(repo, 'file.txt'), 'base\n')
  await gitExecFileAsync(['add', '.'], { cwd: repo })
  await gitExecFileAsync(
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'],
    { cwd: repo }
  )
  return repo
}

function execIn(repo: string) {
  return (argv: string[]) => gitExecFileAsync(argv, { cwd: repo, timeout: 10_000 })
}

describe('countCommitsNotOnRef', () => {
  it('reports zero when HEAD is contained in the default branch and the unique count otherwise', async () => {
    const repo = await initRepo()
    const base = (await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
    await gitExecFileAsync(['checkout', '-q', '-b', 'feature'], { cwd: repo })
    await writeFile(join(repo, 'file.txt'), 'feature\n')
    await gitExecFileAsync(['add', '.'], { cwd: repo })
    await gitExecFileAsync(
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'feature'],
      { cwd: repo }
    )
    const feature = (await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()

    await expect(countCommitsNotOnRef(execIn(repo), 'main', feature)).resolves.toBe(1)
    await expect(countCommitsNotOnRef(execIn(repo), 'main', base)).resolves.toBe(0)
  })

  it('returns null when the comparison cannot be verified', async () => {
    const failing = () => Promise.reject(new Error('ssh unreachable'))
    await expect(countCommitsNotOnRef(failing, 'main', 'abc1234')).resolves.toBeNull()
    await expect(countCommitsNotOnRef(execIn('/missing'), 'main', 'not-an-oid')).resolves.toBeNull()
  })

  it('does not mark an unreachable default branch as contained', async () => {
    const counts = await countUniqueCommitsAgainstDefaultBranch({
      repoKey: 'missing',
      exec: () => Promise.reject(new Error('no route')),
      heads: [{ id: 'wt', head: '0123456789abcdef' }]
    })
    expect(counts.size).toBe(0)
  })
})
