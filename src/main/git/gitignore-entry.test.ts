import { mkdtempSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_GITIGNORE_ENTRY_COUNT,
  MAX_GITIGNORE_RELATIVE_PATH_LENGTH
} from '../../shared/gitignore-entry'
import { appendGitignoreEntries } from './gitignore-entry'

describe('appendGitignoreEntries', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'gitignore-entry-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(`${dir}-outside`, { force: true })
  })

  it('creates .gitignore and appends file and directory patterns in one write', async () => {
    const result = await appendGitignoreEntries(dir, [
      { relativePath: 'src/generated.ts', isDirectory: false },
      { relativePath: 'build', isDirectory: true }
    ])

    await expect(fs.readFile(path.join(dir, '.gitignore'), 'utf8')).resolves.toBe(
      'src/generated.ts\nbuild/\n'
    )
    expect(result).toEqual({ added: ['src/generated.ts', 'build'], alreadyPresent: [] })
  })

  it('normalizes Windows separators and escapes literal gitignore syntax', async () => {
    await appendGitignoreEntries(dir, [
      { relativePath: 'generated\\[draft] #1?.txt', isDirectory: false }
    ])

    await expect(fs.readFile(path.join(dir, '.gitignore'), 'utf8')).resolves.toBe(
      'generated/\\[draft\\]\\ \\#1\\?.txt\n'
    )
  })

  it('preserves CRLF and inserts a separator when the file has no final newline', async () => {
    await fs.writeFile(path.join(dir, '.gitignore'), '*.log\r\n.env')

    await appendGitignoreEntries(dir, [{ relativePath: 'dist', isDirectory: true }])

    await expect(fs.readFile(path.join(dir, '.gitignore'), 'utf8')).resolves.toBe(
      '*.log\r\n.env\r\ndist/\r\n'
    )
  })

  it('reports exact existing patterns and deduplicates repeated batch entries', async () => {
    await fs.writeFile(path.join(dir, '.gitignore'), 'dist/\nsrc/generated.ts\ncache\n')

    const result = await appendGitignoreEntries(dir, [
      { relativePath: 'dist', isDirectory: true },
      { relativePath: 'src/generated.ts', isDirectory: false },
      { relativePath: 'cache', isDirectory: true },
      { relativePath: 'tmp', isDirectory: true },
      { relativePath: 'tmp', isDirectory: true }
    ])

    expect(result).toEqual({
      added: ['tmp'],
      alreadyPresent: ['dist', 'src/generated.ts', 'cache']
    })
    await expect(fs.readFile(path.join(dir, '.gitignore'), 'utf8')).resolves.toBe(
      'dist/\nsrc/generated.ts\ncache\ntmp/\n'
    )
  })

  it.each([
    '/etc/passwd',
    'C:\\Windows\\system.ini',
    '../escape',
    'src/../escape',
    './local',
    'line\nbreak',
    'nul\0byte'
  ])('rejects unsafe path %j', async (relativePath) => {
    await expect(
      appendGitignoreEntries(dir, [{ relativePath, isDirectory: false }])
    ).rejects.toThrow()
  })

  it('rejects malformed and over-limit input', async () => {
    await expect(
      appendGitignoreEntries(dir, [{ relativePath: '', isDirectory: false }])
    ).rejects.toThrow()
    await expect(
      appendGitignoreEntries(dir, [
        { relativePath: 'a'.repeat(MAX_GITIGNORE_RELATIVE_PATH_LENGTH + 1), isDirectory: false }
      ])
    ).rejects.toThrow()
    await expect(
      appendGitignoreEntries(
        dir,
        Array.from({ length: MAX_GITIGNORE_ENTRY_COUNT + 1 }, (_, index) => ({
          relativePath: `file-${index}`,
          isDirectory: false
        }))
      )
    ).rejects.toThrow()
    await expect(
      appendGitignoreEntries(dir, [{ relativePath: 'file', isDirectory: 'no' }])
    ).rejects.toThrow()
  })

  it('serializes concurrent appends so the same rule is written once', async () => {
    const [first, second] = await Promise.all([
      appendGitignoreEntries(dir, [{ relativePath: 'dist', isDirectory: true }]),
      appendGitignoreEntries(dir, [{ relativePath: 'dist', isDirectory: true }])
    ])

    expect([first.added.length, second.added.length].sort()).toEqual([0, 1])
    await expect(fs.readFile(path.join(dir, '.gitignore'), 'utf8')).resolves.toBe('dist/\n')
  })

  it.runIf(process.platform !== 'win32')(
    'refuses to follow a symbolic-link .gitignore',
    async () => {
      const outsidePath = path.join(dir, '..', `${path.basename(dir)}-outside`)
      await fs.writeFile(outsidePath, 'keep\n')
      await fs.symlink(outsidePath, path.join(dir, '.gitignore'))

      await expect(
        appendGitignoreEntries(dir, [{ relativePath: 'dist', isDirectory: true }])
      ).rejects.toThrow(/symbolic-link/)
      await expect(fs.readFile(outsidePath, 'utf8')).resolves.toBe('keep\n')
    }
  )
})
