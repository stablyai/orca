/**
 * Regression: a discard must not destroy staged content. `discardChanges`/
 * `bulkDiscardChanges` previously ran `restore --source=HEAD` (working tree from
 * HEAD, not the index), wiping staged work. Drives the real functions against a
 * real git repo (runner unmocked).
 */
import { execFileSync } from 'child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bulkDiscardChanges, discardChanges } from './status'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

describe('discard preserves staged work', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'orca-discard-'))
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    // Pin line endings so byte assertions hold regardless of global core.autocrlf.
    git(repo, 'config', 'core.autocrlf', 'false')
    git(repo, 'config', 'core.eol', 'lf')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('keeps the staged change when discarding a partially staged (MM) file', async () => {
    const file = path.join(repo, 'foo.txt')
    writeFileSync(file, 'original\n')
    git(repo, 'add', 'foo.txt')
    git(repo, 'commit', '-qm', 'init')
    appendFileSync(file, 'STAGED\n') // staged change
    git(repo, 'add', 'foo.txt')
    appendFileSync(file, 'UNSTAGED\n') // unstaged change on top
    expect(git(repo, 'status', '--porcelain').trim()).toBe('MM foo.txt')

    await discardChanges(repo, 'foo.txt')

    // Only the unstaged change is reverted; staged content stays on disk.
    expect(readFileSync(file, 'utf8')).toBe('original\nSTAGED\n')
    expect(git(repo, 'status', '--porcelain').trim()).toBe('M  foo.txt')
  })

  it('does not delete a newly-added (AM) file when discarding its unstaged edit', async () => {
    const file = path.join(repo, 'new.txt')
    writeFileSync(file, 'STAGED_NEW_WORK\n')
    git(repo, 'add', 'new.txt')
    appendFileSync(file, 'UNSTAGED\n')
    expect(git(repo, 'status', '--porcelain').trim()).toBe('AM new.txt')

    await discardChanges(repo, 'new.txt')

    // File survives with its staged content; the unstaged edit is gone.
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('STAGED_NEW_WORK\n')
    expect(git(repo, 'status', '--porcelain').trim()).toBe('A  new.txt')
  })

  it('does not delete a newly-added (AM) file through the bulk discard path', async () => {
    const file = path.join(repo, 'newbulk.txt')
    writeFileSync(file, 'STAGED_NEW_WORK\n')
    git(repo, 'add', 'newbulk.txt')
    appendFileSync(file, 'UNSTAGED\n')
    expect(git(repo, 'status', '--porcelain').trim()).toBe('AM newbulk.txt')

    await bulkDiscardChanges(repo, ['newbulk.txt'])

    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('STAGED_NEW_WORK\n')
    expect(git(repo, 'status', '--porcelain').trim()).toBe('A  newbulk.txt')
  })

  it('keeps staged content through the bulk discard path', async () => {
    const file = path.join(repo, 'bar.txt')
    writeFileSync(file, 'original\n')
    git(repo, 'add', 'bar.txt')
    git(repo, 'commit', '-qm', 'init')
    appendFileSync(file, 'STAGED\n')
    git(repo, 'add', 'bar.txt')
    appendFileSync(file, 'UNSTAGED\n')
    expect(git(repo, 'status', '--porcelain').trim()).toBe('MM bar.txt')

    await bulkDiscardChanges(repo, ['bar.txt'])

    expect(readFileSync(file, 'utf8')).toBe('original\nSTAGED\n')
    expect(git(repo, 'status', '--porcelain').trim()).toBe('M  bar.txt')
  })
})
