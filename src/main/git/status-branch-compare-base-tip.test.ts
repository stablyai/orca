import { runProcess } from '@orca/process-host'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getBranchCompare, getBranchDiff, getStatus, invalidateGitReadCaches } from './status'

const roots: string[] = []

async function git(repo: string, ...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: repo })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'orca-selected-base-compare-'))
  roots.push(repo)
  await git(repo, 'init', '-q')
  await git(repo, 'config', 'user.email', 'test@example.com')
  await git(repo, 'config', 'user.name', 'Test')
  await git(repo, 'config', 'commit.gpgSign', 'false')
  await writeFile(join(repo, 'file.txt'), 'initial\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'initial')
  await git(repo, 'branch', 'base')
  return repo
}

beforeEach(() => invalidateGitReadCaches())
afterEach(async () => {
  invalidateGitReadCaches()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('selected branch tip comparison', () => {
  it.each([false, true])(
    'changes the file list, contents and total when the selected base changes (diverged: %s)',
    async (diverged) => {
      const repo = await createRepo()
      const child = join(repo, 'child')
      await git(repo, 'worktree', 'add', '-qb', 'feature', child, 'HEAD')
      const forkOid = await git(child, 'rev-parse', 'HEAD')
      if (diverged) {
        await writeFile(join(child, 'file.txt'), 'feature\n')
        await git(child, 'commit', '-qam', 'feature')
      }
      const headOid = await git(child, 'rev-parse', 'HEAD')
      await git(repo, 'checkout', '-q', 'base')
      await writeFile(join(repo, 'file.txt'), 'parent-one\n')
      await git(repo, 'commit', '-qam', 'first base')
      await git(repo, 'checkout', '-qb', 'other-base')
      await writeFile(join(repo, 'file.txt'), 'parent-two\nextra\n')
      await git(repo, 'commit', '-qam', 'second base')

      for (const [ref, contents, removed] of [
        ['base', 'parent-one\n', 1],
        ['other-base', 'parent-two\nextra\n', 2]
      ] as const) {
        const baseOid = await git(repo, 'rev-parse', ref)
        const compare = await getBranchCompare(child, ref, { compareBaseTip: true })
        expect(compare.summary).toMatchObject({
          status: 'ready',
          baseOid,
          headOid,
          mergeBase: baseOid,
          changedFiles: 1
        })
        expect(compare.entries).toEqual([
          { path: 'file.txt', status: 'modified', added: 1, removed }
        ])
        expect(
          await getBranchDiff(child, { mergeBase: baseOid, headOid, filePath: 'file.txt' })
        ).toMatchObject({
          originalContent: contents,
          modifiedContent: diverged ? 'feature\n' : 'initial\n'
        })
        expect(
          (await getStatus(child, { branchLineTotalMergeBase: baseOid })).branchLineTotal
        ).toMatchObject({ mergeBase: baseOid, added: 1, removed })
      }

      const legacy = await getBranchCompare(child, 'base')
      expect(legacy.summary.mergeBase).toBe(forkOid)
      expect(legacy.summary.changedFiles).toBe(diverged ? 1 : 0)
    }
  )

  it.each(['added', 'renamed'] as const)(
    'clears an untracked overlap with a file %s on the base',
    async (change) => {
      const repo = await createRepo()
      await git(repo, 'checkout', '-qb', 'feature')
      await git(repo, 'checkout', '-q', 'base')
      await (change === 'renamed'
        ? git(repo, 'mv', 'file.txt', 'new.txt')
        : writeFile(join(repo, 'new.txt'), 'same\n'))
      await git(repo, 'add', 'new.txt')
      await git(repo, 'commit', '-qm', 'base changes file')
      await git(repo, 'checkout', '-q', 'feature')
      await writeFile(join(repo, 'new.txt'), change === 'renamed' ? 'initial\n' : 'same\n')
      const compare = await getBranchCompare(repo, 'base', { compareBaseTip: true })
      const baseOid = compare.summary.baseOid
      if (!baseOid) {
        throw new Error('Missing base tip')
      }

      const options = { branchLineTotalMergeBase: compare.summary.mergeBase ?? undefined }
      const unavailable = await getStatus(repo, options)
      expect(unavailable.branchLineTotal).toBeUndefined()
      expect(unavailable.branchLineTotalUnavailable).toBe(baseOid)
      await git(repo, 'add', 'new.txt')
      invalidateGitReadCaches()
      expect((await getStatus(repo, options)).branchLineTotal).toMatchObject({
        added: change === 'renamed' ? 1 : 0,
        removed: 0
      })
    }
  )

  it('compares branch tips without requiring shared history', async () => {
    const repo = await createRepo()
    await git(repo, 'checkout', '-q', '--orphan', 'unrelated')
    await writeFile(join(repo, 'file.txt'), 'unrelated\n')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-qm', 'unrelated root')

    const compare = await getBranchCompare(repo, 'base', { compareBaseTip: true })
    expect(compare.summary).toMatchObject({
      status: 'ready',
      changedFiles: 1,
      commitsAhead: 1,
      commitsBehind: 1
    })
    expect(compare.summary.mergeBase).toBe(compare.summary.baseOid)
    expect((await getBranchCompare(repo, 'base')).summary.status).toBe('no-merge-base')
  })
})
