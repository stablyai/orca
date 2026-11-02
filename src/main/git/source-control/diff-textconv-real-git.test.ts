import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDiff } from './file-diff'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'

describe('diff drivers with textconv', () => {
  let repo: string

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString()

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'orca-textconv-'))
    git('init')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test User')
    invalidateGitReadCaches()
  })

  afterEach(async () => {
    invalidateGitReadCaches()
    await rm(repo, { recursive: true, force: true })
  })

  it('diffs clean/smudge-encrypted files as plaintext', async () => {
    // Stand-in for git-crypt: binary stored blob, plaintext working tree, driver passes plaintext through.
    await writeFile(path.join(repo, '.gitattributes'), 'secret.env filter=fake diff=fake\n')
    git('config', 'filter.fake.clean', "printf 'X\\000'; cat")
    git('config', 'filter.fake.smudge', 'tail -c +3')
    git('config', 'diff.fake.textconv', 'cat')
    await writeFile(path.join(repo, 'secret.env'), 'TOKEN=one\n')
    git('add', '.')
    git('commit', '-m', 'init')
    await writeFile(path.join(repo, 'secret.env'), 'TOKEN=two\n')

    expect(await getDiff(repo, 'secret.env', false)).toMatchObject({
      kind: 'text',
      originalContent: 'TOKEN=one\n',
      modifiedContent: 'TOKEN=two\n'
    })

    git('add', 'secret.env')
    expect(await getDiff(repo, 'secret.env', true)).toMatchObject({
      kind: 'text',
      originalContent: 'TOKEN=one\n',
      modifiedContent: 'TOKEN=two\n'
    })
  })

  it('shows the editable unstaged side against checkout bytes, not driver text', async () => {
    await writeFile(path.join(repo, '.gitattributes'), 'notes.txt diff=upper\n')
    git('config', 'diff.upper.textconv', 'tr a-z A-Z <')
    await writeFile(path.join(repo, 'notes.txt'), 'one\n')
    git('add', '.')
    git('commit', '-m', 'init')
    // Already driver-shaped, so only the original side tells checkout bytes from driver text.
    await writeFile(path.join(repo, 'notes.txt'), 'TWO\n')

    expect(await getDiff(repo, 'notes.txt', false)).toMatchObject({
      originalContent: 'one\n',
      modifiedContent: 'TWO\n'
    })
    git('add', 'notes.txt')
    expect(await getDiff(repo, 'notes.txt', true)).toMatchObject({
      originalContent: 'ONE\n',
      modifiedContent: 'TWO\n'
    })
  })

  it('falls back to the stored blob when the driver fails', async () => {
    await writeFile(path.join(repo, '.gitattributes'), 'notes.txt diff=broken\n')
    git('config', 'diff.broken.textconv', 'false')
    await writeFile(path.join(repo, 'notes.txt'), 'one\n')
    git('add', '.')
    git('commit', '-m', 'init')
    await writeFile(path.join(repo, 'notes.txt'), 'two\n')
    git('add', 'notes.txt')

    expect(await getDiff(repo, 'notes.txt', true)).toMatchObject({
      kind: 'text',
      originalContent: 'one\n',
      modifiedContent: 'two\n'
    })
  })

  it('re-reads driver output once the driver recovers', async () => {
    await writeFile(path.join(repo, '.gitattributes'), 'notes.txt diff=keyed\n')
    // Stand-in for a locked key: the driver fails until the marker exists.
    git('config', 'diff.keyed.textconv', 'test -f key && tr a-z A-Z <')
    await writeFile(path.join(repo, 'notes.txt'), 'one\n')
    git('add', '.')
    git('commit', '-m', 'init')
    await writeFile(path.join(repo, 'notes.txt'), 'two\n')
    git('add', 'notes.txt')
    // Age the stamped inputs so the first result is old enough to settle.
    const old = new Date('2020-01-01T00:00:00Z')
    await utimes(path.join(repo, '.git', 'index'), old, old)

    expect(await getDiff(repo, 'notes.txt', true)).toMatchObject({ originalContent: 'one\n' })
    await writeFile(path.join(repo, 'key'), '')
    expect(await getDiff(repo, 'notes.txt', true)).toMatchObject({ originalContent: 'ONE\n' })
  })

  it('does not read a replaced directory through the driver as file content', async () => {
    await writeFile(path.join(repo, '.gitattributes'), 'foo diff=upper\n')
    git('config', 'diff.upper.textconv', 'tr a-z A-Z <')
    await mkdir(path.join(repo, 'foo'))
    await writeFile(path.join(repo, 'foo', 'bar'), 'x\n')
    git('add', '.')
    git('commit', '-m', 'init')
    git('rm', '-rq', 'foo')
    await writeFile(path.join(repo, 'foo'), 'file\n')
    git('add', 'foo')

    expect(await getDiff(repo, 'foo', true)).toMatchObject({ originalContent: '' })
  })
})
