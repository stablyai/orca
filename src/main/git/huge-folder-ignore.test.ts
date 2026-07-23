import { mkdtempSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { checkIgnoredPathsMock } = vi.hoisted(() => ({
  checkIgnoredPathsMock: vi.fn<(worktreePath: string, paths: string[]) => Promise<string[]>>()
}))

vi.mock('./check-ignored-paths', () => ({
  checkIgnoredPaths: checkIgnoredPathsMock
}))

import { appendFolderToGitignore, findKnownHugeFolderPathsToIgnore } from './huge-folder-ignore'

describe('findKnownHugeFolderPathsToIgnore', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'huge-folder-'))
    checkIgnoredPathsMock.mockReset()
    checkIgnoredPathsMock.mockResolvedValue([])
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('returns existing known-huge folders that are not already ignored', async () => {
    await fs.mkdir(path.join(dir, 'node_modules'))
    await fs.mkdir(path.join(dir, 'dist'))

    const result = await findKnownHugeFolderPathsToIgnore(dir)

    expect(result).toContain('node_modules')
    expect(result).toContain('dist')
  })

  it('excludes folders that are already git-ignored', async () => {
    await fs.mkdir(path.join(dir, 'node_modules'))
    checkIgnoredPathsMock.mockResolvedValue(['node_modules'])

    const result = await findKnownHugeFolderPathsToIgnore(dir)

    expect(result).not.toContain('node_modules')
  })

  it('returns nothing when no known-huge folders exist', async () => {
    const result = await findKnownHugeFolderPathsToIgnore(dir)
    expect(result).toEqual([])
  })
})

describe('appendFolderToGitignore', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'huge-folder-write-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('creates .gitignore with the folder pattern when absent', async () => {
    const wrote = await appendFolderToGitignore(dir, 'node_modules')
    expect(wrote).toBe(true)
    const content = await fs.readFile(path.join(dir, '.gitignore'), 'utf-8')
    expect(content).toContain('node_modules/')
  })

  it('appends with a leading newline when the file lacks a trailing one', async () => {
    await fs.writeFile(path.join(dir, '.gitignore'), '*.log')
    const wrote = await appendFolderToGitignore(dir, 'dist')
    expect(wrote).toBe(true)
    const content = await fs.readFile(path.join(dir, '.gitignore'), 'utf-8')
    expect(content).toBe('*.log\ndist/\n')
  })

  it('is a no-op when the folder is already listed', async () => {
    await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules/\n')
    const wrote = await appendFolderToGitignore(dir, 'node_modules')
    expect(wrote).toBe(false)
  })

  it('streams a large single-line file while preserving append semantics', async () => {
    const gitignorePath = path.join(dir, '.gitignore')
    await fs.writeFile(gitignorePath, 'x')
    await fs.truncate(gitignorePath, 8 * 1024 * 1024)

    expect(await appendFolderToGitignore(dir, 'dist')).toBe(true)

    const handle = await fs.open(gitignorePath, 'r')
    try {
      const info = await handle.stat()
      const tail = Buffer.alloc(7)
      await handle.read(tail, 0, tail.length, info.size - tail.length)
      expect(tail.toString('utf8')).toBe('\ndist/\n')
    } finally {
      await handle.close()
    }
  })

  it('preserves trimmed-line matching across streamed chunks', async () => {
    const gitignorePath = path.join(dir, '.gitignore')
    await fs.writeFile(gitignorePath, 'x')
    await fs.truncate(gitignorePath, 8 * 1024 * 1024)
    await fs.appendFile(gitignorePath, '\n\u00a0node_modules/\u00a0\n')
    const sizeBefore = (await fs.stat(gitignorePath)).size

    expect(await appendFolderToGitignore(dir, 'node_modules')).toBe(false)
    expect((await fs.stat(gitignorePath)).size).toBe(sizeBefore)
  })

  it('rejects folder names outside the known allowlist (injection guard)', async () => {
    await expect(appendFolderToGitignore(dir, 'node_modules\n/etc/passwd')).rejects.toThrow(
      /Refusing to add/
    )
    await expect(appendFolderToGitignore(dir, '../escape')).rejects.toThrow(/Refusing to add/)
    await expect(appendFolderToGitignore(dir, 'arbitrary')).rejects.toThrow(/Refusing to add/)
  })
})
