import { readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { bulkUnstageFiles, unstageFile } from './staging'
import { bulkDiscardChanges, discardChanges } from './discard-changes'

function gitInit(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'pipe' })
}

function gitCommit(dir: string, message: string): void {
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', message, '--allow-empty'], { cwd: dir, stdio: 'pipe' })
}

const modes = [{ bulk: false }, { bulk: true }] as const

describe('staging and discard preserve index authority', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'orca-real-git-'))
    gitInit(repo)
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  async function git(args: string[], input?: string): Promise<string> {
    const result = await runProcess({ program: 'git', args, cwd: repo, input })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout
  }

  function mutate(
    mode: (typeof modes)[number],
    action: 'unstage' | 'discard',
    filePaths: string[]
  ): Promise<unknown> {
    if (mode.bulk) {
      return (action === 'unstage' ? bulkUnstageFiles : bulkDiscardChanges)(repo, filePaths)
    }
    return (action === 'unstage' ? unstageFile : discardChanges)(repo, filePaths[0])
  }

  it.each(modes)('preserves staged MM content during bulk=$bulk discard', async (mode) => {
    await writeFile(path.join(repo, 'file.txt'), 'committed\n')
    gitCommit(repo, 'initial')
    await writeFile(path.join(repo, 'file.txt'), 'staged\n')
    await git(['add', 'file.txt'])
    await writeFile(path.join(repo, 'file.txt'), 'working\n')

    await mutate(mode, 'discard', ['file.txt'])

    expect(await readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('staged\n')
    expect(await git(['show', ':file.txt'])).toBe('staged\n')
    expect(await git(['diff', '--name-only'])).toBe('')
    expect(await git(['diff', '--cached', '--name-only'])).toBe('file.txt\n')
  })

  it.each(modes)('restores staged additions during bulk=$bulk AM discard', async (mode) => {
    await writeFile(path.join(repo, 'initial.txt'), 'committed\n')
    gitCommit(repo, 'initial')
    await writeFile(path.join(repo, 'new.txt'), 'staged addition\n')
    await git(['add', 'new.txt'])
    await writeFile(path.join(repo, 'new.txt'), 'working addition\n')

    await mutate(mode, 'discard', ['new.txt'])

    expect(await readFile(path.join(repo, 'new.txt'), 'utf8')).toBe('staged addition\n')
    expect(await git(['show', ':new.txt'])).toBe('staged addition\n')
    expect(await git(['diff', '--name-only'])).toBe('')
  })

  it.each(modes)('unstages selected unborn paths on bulk=$bulk', async (mode) => {
    await writeFile(path.join(repo, 'selected.txt'), 'selected\n')
    await writeFile(path.join(repo, 'keep.txt'), 'keep\n')
    await git(['add', '.'])

    await mutate(mode, 'unstage', ['selected.txt'])

    expect(await git(['ls-files', '-z'])).toBe('keep.txt\0')
    expect(await readFile(path.join(repo, 'selected.txt'), 'utf8')).toBe('selected\n')
  })

  it('unstages both rename paths', async () => {
    await writeFile(path.join(repo, 'old.txt'), 'rename content\n')
    await writeFile(path.join(repo, 'keep.txt'), 'keep\n')
    gitCommit(repo, 'initial')
    await git(['mv', 'old.txt', 'new.txt'])
    await writeFile(path.join(repo, 'keep.txt'), 'keep staged\n')
    await git(['add', 'keep.txt'])

    await mutate({ bulk: true }, 'unstage', ['new.txt', 'old.txt'])

    expect(await git(['diff', '--cached', '--name-only'])).toBe('keep.txt\n')
    expect(await git(['ls-files', '-z'])).toBe('keep.txt\0old.txt\0')
    expect(await readFile(path.join(repo, 'new.txt'), 'utf8')).toBe('rename content\n')
  })

  it('discards a staged rename after unstaging both paths', async () => {
    await writeFile(path.join(repo, 'old.txt'), 'rename content\n')
    gitCommit(repo, 'initial')
    await git(['mv', 'old.txt', 'new.txt'])

    await mutate({ bulk: true }, 'unstage', ['new.txt', 'old.txt'])
    await mutate({ bulk: true }, 'discard', ['new.txt', 'old.txt'])

    expect(await git(['status', '--porcelain'])).toBe('')
    expect(await readFile(path.join(repo, 'old.txt'), 'utf8')).toBe('rename content\n')
    await expect(readFile(path.join(repo, 'new.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it.each(modes)('rejects an unresolved conflict on bulk=$bulk', async (mode) => {
    await writeFile(path.join(repo, 'file.txt'), 'base\n')
    gitCommit(repo, 'initial')
    const blobs = await Promise.all(
      ['base\n', 'ours\n', 'theirs\n'].map((content) =>
        git(['hash-object', '-w', '--stdin'], content)
      )
    )
    await git(
      ['update-index', '--index-info'],
      `0 ${'0'.repeat(40)}\tfile.txt\n${blobs
        .map((oid, index) => `100644 ${oid.trim()} ${index + 1}\tfile.txt\n`)
        .join('')}`
    )
    await writeFile(path.join(repo, 'file.txt'), 'conflict resolution in progress\n')
    const before = await git(['ls-files', '--unmerged', '-z'])

    await expect(mutate(mode, 'discard', ['file.txt'])).rejects.toThrow()

    expect(await readFile(path.join(repo, 'file.txt'), 'utf8')).toBe(
      'conflict resolution in progress\n'
    )
    expect(await git(['ls-files', '--unmerged', '-z'])).toBe(before)
  })
})
