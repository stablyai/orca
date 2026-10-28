import { rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDiff } from './file-diff'
import { MAX_GIT_SHOW_BYTES } from './git-show-max-bytes'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
}

// Text, not binary: only its size keeps it out of a text diff.
const largeText = (): string => 'a line of text\n'.repeat(Math.ceil(MAX_GIT_SHOW_BYTES / 15) + 1)

describe('a diff side past the read cap', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'orca-diff-too-large-'))
    git(repo, ['init'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test User'])
    invalidateGitReadCaches()
  })

  afterEach(async () => {
    invalidateGitReadCaches()
    await rm(repo, { recursive: true, force: true })
  })

  it('is marked too large, still binary for older readers, from the working tree and from Git', async () => {
    await writeFile(path.join(repo, 'big.txt'), 'small\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'initial'])
    await writeFile(path.join(repo, 'big.txt'), largeText())

    expect(await getDiff(repo, 'big.txt', false)).toMatchObject({
      kind: 'binary',
      modifiedIsBinary: true,
      tooLarge: true
    })
    git(repo, ['add', 'big.txt'])
    invalidateGitReadCaches()
    expect(await getDiff(repo, 'big.txt', true)).toMatchObject({
      kind: 'binary',
      modifiedIsBinary: true,
      tooLarge: true
    })
  })

  it('leaves a real binary unmarked', async () => {
    await writeFile(path.join(repo, 'blob.bin'), Buffer.from([1, 0, 2]))
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'initial'])
    await writeFile(path.join(repo, 'blob.bin'), Buffer.from([3, 0, 4]))

    const result = await getDiff(repo, 'blob.bin', false)
    expect(result).toMatchObject({ kind: 'binary', modifiedIsBinary: true })
    expect(result).not.toHaveProperty('tooLarge')
  })
})
