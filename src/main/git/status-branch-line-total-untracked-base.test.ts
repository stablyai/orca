import { runProcess } from '@orca/process-host'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { getBranchCompare, getStatus, invalidateGitReadCaches } from './status'

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

it.each(['one\ntwo\n', 'one\nchanged\n'])(
  'withholds a merge-base total for a deleted tracked file recreated as untracked until staged: %j',
  async (contents) => {
    const repo = await createRepo()
    await writeFile(join(repo, 'new.txt'), 'one\ntwo\n')
    await git(repo, 'add', 'new.txt')
    await git(repo, 'commit', '-qm', 'add upstream file')
    await git(repo, 'checkout', '-B', 'feature', 'base')
    await git(repo, 'rm', 'new.txt')
    await git(repo, 'commit', '-qm', 'delete tracked file on feature')
    const compare = await getBranchCompare(repo, 'base')
    const comparisonBase = compare.summary.mergeBase
    if (!comparisonBase) {
      throw new Error('Missing comparison base')
    }
    const options = { branchLineTotalMergeBase: comparisonBase }
    expect((await getStatus(repo, options)).branchLineTotal).toMatchObject({ added: 0, removed: 2 })

    await writeFile(join(repo, 'new.txt'), contents)
    const unavailable = await getStatus(repo, options)
    expect(unavailable.branchLineTotal).toBeUndefined()
    expect(unavailable.branchLineTotalUnavailable).toBe(comparisonBase)
    const reused = await getStatus(repo, { ...options, reuseLineStats: true })
    expect(reused.branchLineTotal).toBeUndefined()
    expect(reused.branchLineTotalUnavailable).toBe(comparisonBase)

    await git(repo, 'add', 'new.txt')
    invalidateGitReadCaches()
    const expected = contents === 'one\ntwo\n' ? 0 : 1
    expect((await getStatus(repo, options)).branchLineTotal).toMatchObject({
      added: expected,
      removed: expected
    })
  }
)

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

  const unavailable = await getStatus(repo, options)
  expect(unavailable.branchLineTotal).toBeUndefined()
  expect(unavailable.branchLineTotalUnavailable).toBe(baseOid)
  const reused = await getStatus(repo, { ...options, reuseLineStats: true })
  expect(reused.branchLineTotal).toBeUndefined()
  expect(reused.branchLineTotalUnavailable).toBe(baseOid)
  await git(repo, 'add', oldPath)
  invalidateGitReadCaches()
  expect((await getStatus(repo, options)).branchLineTotal).toMatchObject({ added: 3, removed: 2 })
})
