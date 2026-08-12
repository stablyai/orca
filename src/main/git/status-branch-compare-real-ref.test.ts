import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getBranchCompare } from './status'

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

    const result = await getBranchCompare(client, 'origin/tagbase')

    expect(result.summary).toMatchObject({ baseOid: rawOid, status: 'ready' })
  })
})
