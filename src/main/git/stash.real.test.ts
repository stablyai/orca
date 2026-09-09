import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listStashes, listStashFiles } from './stash'
import { getCommitCompare } from './source-control/commit-compare'
import { getCommitDiff } from './source-control/commit-diff'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function createRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'orca-stash-'))
  tempRoots.push(repoPath)
  git(repoPath, ['init', '--quiet'])
  git(repoPath, ['config', 'user.email', 'stash@example.com'])
  git(repoPath, ['config', 'user.name', 'Stash Tester'])
  await writeFile(join(repoPath, 'tracked.txt'), 'before\n')
  git(repoPath, ['add', 'tracked.txt'])
  git(repoPath, ['commit', '--quiet', '-m', 'initial'])
  return repoPath
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('stash files with real Git', () => {
  it('routes tracked and untracked files through their owning stash commits', async () => {
    const repoPath = await createRepo()
    await writeFile(join(repoPath, 'tracked.txt'), 'after\n')
    await writeFile(join(repoPath, 'untracked.txt'), 'new\n')
    git(repoPath, ['stash', 'push', '--include-untracked', '--message', 'mixed'])

    const [stash] = await listStashes(repoPath)
    const files = await listStashFiles(repoPath, stash.ref)
    const tracked = files.find((file) => file.path === 'tracked.txt')
    const untracked = files.find((file) => file.path === 'untracked.txt')

    expect(tracked?.commitId).toBe(stash.commitId)
    expect(untracked?.commitId).toMatch(/^[0-9a-f]{40,64}$/)
    expect(untracked?.commitId).not.toBe(stash.commitId)
    expect(git(repoPath, ['show', `${untracked?.commitId}:untracked.txt`])).toBe('new')

    const compare = await getCommitCompare(repoPath, untracked!.commitId!)
    const entry = compare.entries.find((candidate) => candidate.path === 'untracked.txt')
    expect(entry?.status).toBe('added')
    await expect(
      getCommitDiff(repoPath, {
        commitOid: compare.summary.commitOid,
        parentOid: compare.summary.parentOid,
        filePath: entry!.path
      })
    ).resolves.toMatchObject({ kind: 'text', originalContent: '', modifiedContent: 'new\n' })
  })

  it('keeps tracked-only stashes on the main stash commit', async () => {
    const repoPath = await createRepo()
    await writeFile(join(repoPath, 'tracked.txt'), 'after\n')
    git(repoPath, ['stash', 'push', '--message', 'tracked'])

    const [stash] = await listStashes(repoPath)
    const files = await listStashFiles(repoPath, stash.ref)
    expect(files).toEqual([
      { status: 'M', path: 'tracked.txt', commitId: stash.commitId }
    ])
    const compare = await getCommitCompare(repoPath, files[0].commitId!)
    await expect(
      getCommitDiff(repoPath, {
        commitOid: compare.summary.commitOid,
        parentOid: compare.summary.parentOid,
        filePath: files[0].path
      })
    ).resolves.toMatchObject({
      kind: 'text',
      originalContent: 'before\n',
      modifiedContent: 'after\n'
    })
  })
})
