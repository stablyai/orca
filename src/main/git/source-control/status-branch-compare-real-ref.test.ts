import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getBranchCompare } from './branch-compare'

const tempRoots: string[] = []

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('getBranchCompare real refs', () => {
  it.each([false, true])(
    'excludes base-only changes after branches diverge: %s',
    async (diverged) => {
      const repo = await mkdtemp(path.join(tmpdir(), 'orca-common-ancestor-compare-'))
      tempRoots.push(repo)
      git(repo, ['init', '-q'])
      git(repo, ['config', 'user.email', 'test@example.com'])
      git(repo, ['config', 'user.name', 'Test User'])
      git(repo, ['config', 'commit.gpgSign', 'false'])
      git(repo, ['commit', '--allow-empty', '-qm', 'initial'])
      const forkOid = git(repo, ['rev-parse', 'HEAD'])
      git(repo, ['branch', 'base'])
      git(repo, ['checkout', '-qb', 'feature'])
      if (diverged) {
        await writeFile(path.join(repo, 'feature.txt'), 'feature\n')
        git(repo, ['add', 'feature.txt'])
        git(repo, ['commit', '-qm', 'feature addition'])
      }
      git(repo, ['checkout', '-q', 'base'])
      await writeFile(path.join(repo, 'upstream.txt'), 'upstream\n')
      git(repo, ['add', 'upstream.txt'])
      git(repo, ['commit', '-qm', 'upstream addition'])
      git(repo, ['checkout', '-q', 'feature'])

      const result = await getBranchCompare(repo, 'base')
      expect(result.summary).toMatchObject({
        status: 'ready',
        mergeBase: forkOid,
        commitsAhead: diverged ? 1 : 0,
        commitsBehind: 1,
        changedFiles: diverged ? 1 : 0
      })
      expect(result.entries).toEqual(
        diverged ? [{ path: 'feature.txt', status: 'added', added: 1, removed: 0 }] : []
      )
    }
  )

  it('reports equal commits as empty despite staged and unstaged changes', async () => {
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

    expect(await getBranchCompare(repo, 'base')).toEqual({
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
  })

  it('recounts an unchanged commit pair after a replace ref rewrites its history', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'orca-branch-compare-replace-'))
    tempRoots.push(repo)
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test User'])
    git(repo, ['config', 'commit.gpgSign', 'false'])
    git(repo, ['commit', '--allow-empty', '-qm', 'root'])
    const rootOid = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['branch', 'base'])
    git(repo, ['checkout', '-qb', 'feature'])
    git(repo, ['commit', '--allow-empty', '-qm', 'middle'])
    git(repo, ['commit', '--allow-empty', '-qm', 'tip'])
    const tipOid = git(repo, ['rev-parse', 'HEAD'])

    expect((await getBranchCompare(repo, 'base')).summary).toMatchObject({
      status: 'ready',
      commitsAhead: 2
    })

    git(repo, ['replace', '--graft', tipOid, rootOid])
    // Age the new replace ref past the racy-write margin so only the stamp can force a recount.
    const aged = new Date(Date.now() - 60_000)
    const replaceDir = path.join(repo, '.git', 'refs', 'replace')
    await utimes(path.join(replaceDir, tipOid), aged, aged)
    await utimes(replaceDir, aged, aged)

    expect((await getBranchCompare(repo, 'base')).summary).toMatchObject({
      status: 'ready',
      headOid: tipOid,
      mergeBase: rootOid,
      commitsAhead: 1
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

    expect((await getBranchCompare(client, 'origin/tagbase')).summary).toMatchObject({
      baseOid: rawOid,
      headOid: peeledOid,
      mergeBase: peeledOid,
      changedFiles: 0,
      commitsAhead: 0,
      commitsBehind: 0,
      status: 'ready'
    })
  })
})
