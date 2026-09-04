import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isUncommittedBlameOid } from '../../shared/git-blame'
import { getFileBlame } from './blame'

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

describe('getFileBlame real git', () => {
  it('returns the committing author for a tracked line and marks an uncommitted edit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-blame-'))
    tempRoots.push(root)
    git(root, ['init', '-q'])
    git(root, ['config', 'user.email', 'ada@example.com'])
    git(root, ['config', 'user.name', 'Ada Lovelace'])
    git(root, ['config', 'commit.gpgSign', 'false'])
    await writeFile(path.join(root, 'note.txt'), 'hello\n', 'utf8')
    git(root, ['add', 'note.txt'])
    git(root, ['commit', '-q', '-m', 'Add note'])
    const committedOid = git(root, ['rev-parse', 'HEAD'])

    await writeFile(path.join(root, 'note.txt'), 'hello\nworld\n', 'utf8')
    const result = await getFileBlame(root, 'note.txt')

    expect(result.status).toBe('ready')
    expect(result.lines[0]).toMatchObject({
      line: 1,
      commitOid: committedOid,
      author: 'Ada Lovelace',
      summary: 'Add note'
    })
    expect(isUncommittedBlameOid(result.lines[1]?.commitOid ?? '')).toBe(true)
  })

  it('returns unavailable for a path git cannot blame', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-blame-missing-'))
    tempRoots.push(root)
    git(root, ['init', '-q'])
    git(root, ['config', 'user.email', 'ada@example.com'])
    git(root, ['config', 'user.name', 'Ada Lovelace'])
    git(root, ['config', 'commit.gpgSign', 'false'])
    git(root, ['commit', '--allow-empty', '-q', '-m', 'empty'])

    await expect(getFileBlame(root, 'missing.txt')).resolves.toEqual({
      status: 'unavailable',
      lines: []
    })
  })

  it('blames a historical revision instead of the working tree', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-blame-rev-'))
    tempRoots.push(root)
    git(root, ['init', '-q'])
    git(root, ['config', 'user.email', 'ada@example.com'])
    git(root, ['config', 'user.name', 'Ada Lovelace'])
    git(root, ['config', 'commit.gpgSign', 'false'])
    await writeFile(path.join(root, 'note.txt'), 'hello\n', 'utf8')
    git(root, ['add', 'note.txt'])
    git(root, ['commit', '-q', '-m', 'Add note'])
    const firstOid = git(root, ['rev-parse', 'HEAD'])
    await writeFile(path.join(root, 'note.txt'), 'hello\nworld\n', 'utf8')
    git(root, ['add', 'note.txt'])
    git(root, ['commit', '-q', '-m', 'Expand note'])

    const result = await getFileBlame(root, 'note.txt', {}, firstOid)
    expect(result.status).toBe('ready')
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]).toMatchObject({
      line: 1,
      commitOid: firstOid,
      summary: 'Add note'
    })
  })
})
