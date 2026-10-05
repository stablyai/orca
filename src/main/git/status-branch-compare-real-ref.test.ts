import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getBranchCompare } from './status'
import { branchCompare } from '../../relay/git-handler-ops'
import { gitChangeListArgs, parseGitChangeList } from '../../shared/git-change-list'

const tempRoots: string[] = []

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function relayCompare(repo: string, baseRef: string) {
  return branchCompare(
    async (args, cwd) => ({ stdout: git(cwd, args), stderr: '' }),
    repo,
    baseRef,
    async (mergeBase, headOid) =>
      parseGitChangeList(git(repo, gitChangeListArgs(mergeBase, headOid)))
  )
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('getBranchCompare real refs', () => {
  it('reports equal commits as empty on native and relay despite staged and unstaged changes', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'orca-equal-branch-compare-'))
    tempRoots.push(repo)
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test User'])
    git(repo, ['-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'initial'])
    git(repo, ['branch', 'base'])
    git(repo, ['checkout', '-q', '-b', 'feature'])
    const oid = git(repo, ['rev-parse', 'HEAD'])
    await writeFile(path.join(repo, 'changes.txt'), 'staged\n')
    git(repo, ['add', 'changes.txt'])
    await writeFile(path.join(repo, 'changes.txt'), 'unstaged\n')

    for (const result of await Promise.all([
      getBranchCompare(repo, 'base'),
      relayCompare(repo, 'base')
    ])) {
      expect(result).toEqual({
        summary: {
          baseRef: 'base',
          baseOid: oid,
          compareRef: 'feature',
          headOid: oid,
          mergeBase: oid,
          changedFiles: 0,
          commitsAhead: 0,
          commitsBehind: 0,
          status: 'ready'
        },
        entries: []
      })
    }
  })

  it('keeps the merge-base failure for identical blob tips on the relay', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'orca-blob-branch-compare-'))
    tempRoots.push(repo)
    git(repo, ['init', '-q'])
    await writeFile(path.join(repo, 'blob.txt'), 'not a commit\n')
    const oid = git(repo, ['hash-object', '-w', 'blob.txt'])
    await writeFile(path.join(repo, '.git', 'HEAD'), `${oid}\n`)

    await expect(relayCompare(repo, oid)).resolves.toMatchObject({
      summary: { headOid: oid, baseOid: oid, status: 'no-merge-base', mergeBase: null },
      entries: []
    })
  })

  it('preserves the raw oid of a remote-tracking ref that stores an annotated tag', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-branch-compare-ref-'))
    tempRoots.push(root)
    const source = path.join(root, 'source')
    const client = path.join(root, 'client')

    execFileSync('git', ['init', '-q', source])
    git(source, ['config', 'user.email', 'test@example.com'])
    git(source, ['config', 'user.name', 'Test User'])
    git(source, ['config', 'commit.gpgSign', 'false'])
    git(source, ['config', 'tag.gpgSign', 'false'])
    git(source, ['commit', '--allow-empty', '-m', 'initial'])
    git(source, ['tag', '-a', 'annotated', '-m', 'annotated base'])
    execFileSync('git', ['clone', '-q', source, client])
    git(client, ['fetch', source, 'refs/tags/annotated:refs/remotes/origin/tagbase'])

    expect(git(client, ['branch', '-r', '--format=%(refname:short)']).split(/\r?\n/)).toContain(
      'origin/tagbase'
    )
    const rawOid = git(client, ['rev-parse', '--verify', 'refs/remotes/origin/tagbase'])
    const peeledOid = git(client, [
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/remotes/origin/tagbase^{commit}'
    ])
    expect(rawOid).not.toBe(peeledOid)

    for (const result of await Promise.all([
      getBranchCompare(client, 'origin/tagbase'),
      relayCompare(client, 'origin/tagbase')
    ])) {
      expect(result.summary).toMatchObject({
        baseOid: rawOid,
        headOid: peeledOid,
        mergeBase: peeledOid,
        changedFiles: 0,
        commitsAhead: 0,
        commitsBehind: 0,
        status: 'ready'
      })
    }
  })
})
