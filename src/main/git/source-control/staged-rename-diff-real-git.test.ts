import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { getDiff } from './file-diff'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'

const OLD_PATH = 'old.txt'
const NEW_PATH = 'new.txt'
const ORIGINAL = 'first\nsecond\nthird\nfourth\nfifth\nsixth\n'
const STAGED = ORIGINAL.replace('third', 'staged third')

describe('staged rename diffs with real Git', () => {
  let repo: string

  async function git(args: string[]): Promise<string> {
    const result = await runProcess({ program: 'git', args, cwd: repo })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout
  }

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'orca-staged-rename-'))
    await git(['init'])
    await git(['config', 'user.email', 'test@example.invalid'])
    await git(['config', 'user.name', 'Orca Test'])
    await writeFile(path.join(repo, OLD_PATH), ORIGINAL)
    await git(['add', '--all'])
    await git([
      '-c',
      'core.hooksPath=.git/no-hooks',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Initial'
    ])
    await rename(path.join(repo, OLD_PATH), path.join(repo, NEW_PATH))
    invalidateGitReadCaches()
  })

  afterEach(async () => {
    invalidateGitReadCaches()
    await rm(repo, { recursive: true, force: true })
  })

  it('preserves both versions of a pure rename', async () => {
    await git(['add', '--all'])
    expect(await git(['diff', '--cached', '--name-status'])).toContain('R100')

    expect(await getDiff(repo, NEW_PATH, true, false, { oldPath: OLD_PATH })).toMatchObject({
      kind: 'text',
      originalContent: ORIGINAL,
      modifiedContent: ORIGINAL
    })
  })

  it('compares the source in HEAD with the staged destination and excludes later edits', async () => {
    await writeFile(path.join(repo, NEW_PATH), STAGED)
    await git(['add', '--all'])
    expect(await git(['diff', '--cached', '--name-status'])).toMatch(/^R\d+/)
    await writeFile(path.join(repo, NEW_PATH), 'later unstaged edit\n')

    expect(await getDiff(repo, NEW_PATH, true, false, { oldPath: OLD_PATH })).toMatchObject({
      originalContent: ORIGINAL,
      modifiedContent: STAGED
    })
    expect(await getDiff(repo, NEW_PATH, false, false, { oldPath: OLD_PATH })).toMatchObject({
      originalContent: STAGED,
      modifiedContent: 'later unstaged edit\n'
    })
  })
})
