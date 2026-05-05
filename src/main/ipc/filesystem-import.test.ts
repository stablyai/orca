import path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown>>()
const { handleMock, lstatMock, mkdirMock, realpathMock, copyFileMock, readdirMock } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    lstatMock: vi.fn(),
    mkdirMock: vi.fn(),
    realpathMock: vi.fn(),
    copyFileMock: vi.fn(),
    readdirMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

vi.mock('fs/promises', () => ({
  lstat: lstatMock,
  mkdir: mkdirMock,
  rename: vi.fn(),
  writeFile: vi.fn(),
  realpath: realpathMock,
  copyFile: copyFileMock,
  readdir: readdirMock
}))

import { registerFilesystemMutationHandlers } from './filesystem-mutations'

const REPO_PATH = path.resolve('/workspace/repo')
const WORKSPACE_DIR = path.resolve('/workspace')

const store = {
  getRepos: () => [
    { id: 'repo-1', path: REPO_PATH, displayName: 'repo', badgeColor: '#000', addedAt: 0 }
  ],
  getSettings: () => ({ workspaceDir: WORKSPACE_DIR })
}

function enoent(): Error {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

describe('fs:importExternalPaths', () => {
  const destDir = path.resolve('/workspace/repo/src')

  function mockSourceFile(filePath: string): void {
    const resolvedPath = path.resolve(filePath)
    lstatMock.mockImplementation(async (p: string) => {
      if (p === resolvedPath) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
      }
      throw enoent()
    })
  }

  function mockSourceDir(dirPath: string, entries: { name: string; isDir: boolean }[]): void {
    const resolvedDir = path.resolve(dirPath)
    lstatMock.mockImplementation(async (p: string) => {
      if (p === resolvedDir) {
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }
      }
      throw enoent()
    })
    readdirMock.mockImplementation(async () => {
      return entries.map((e) => ({
        name: e.name,
        isDirectory: () => e.isDir,
        isSymbolicLink: () => false,
        isFile: () => !e.isDir
      }))
    })
  }

  function mockSymlinkSource(filePath: string): void {
    const resolvedPath = path.resolve(filePath)
    lstatMock.mockImplementation(async (p: string) => {
      if (p === resolvedPath) {
        return { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true }
      }
      throw enoent()
    })
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    lstatMock.mockReset()
    mkdirMock.mockReset()
    realpathMock.mockReset()
    copyFileMock.mockReset()
    readdirMock.mockReset()

    handleMock.mockImplementation((channel: string, handler: never) => {
      handlers.set(channel, handler)
    })

    realpathMock.mockImplementation(async (p: string) => p)
    lstatMock.mockRejectedValue(enoent())
    mkdirMock.mockResolvedValue(undefined)
    copyFileMock.mockResolvedValue(undefined)
    readdirMock.mockResolvedValue([])

    registerFilesystemMutationHandlers(store as never)
  })

  it('imports a single file', async () => {
    const sourcePath = '/tmp/dropped/logo.png'
    mockSourceFile(sourcePath)

    const result = (await handlers.get('fs:importExternalPaths')!(null, {
      sourcePaths: [sourcePath],
      destDir
    })) as { results: unknown[] }

    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({
      status: 'imported',
      kind: 'file',
      renamed: false,
      destPath: path.join(destDir, 'logo.png')
    })
    expect(copyFileMock).toHaveBeenCalledWith(
      path.resolve(sourcePath),
      path.join(destDir, 'logo.png')
    )
  })

  it('imports multiple files in one batch', async () => {
    const sources = ['/tmp/dropped/a.txt', '/tmp/dropped/b.txt']
    lstatMock.mockImplementation(async (p: string) => {
      const resolved = [path.resolve(sources[0]), path.resolve(sources[1])]
      if (resolved.includes(p)) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
      }
      throw enoent()
    })

    const result = (await handlers.get('fs:importExternalPaths')!(null, {
      sourcePaths: sources,
      destDir
    })) as { results: { status: string }[] }

    expect(result.results).toHaveLength(2)
    expect(result.results[0]).toMatchObject({ status: 'imported' })
    expect(result.results[1]).toMatchObject({ status: 'imported' })
  })

  it('imports a directory recursively', async () => {
    const sourcePath = '/tmp/dropped/assets'
    mockSourceDir(sourcePath, [
      { name: 'icon.png', isDir: false },
      { name: 'fonts', isDir: true }
    ])
    readdirMock
      .mockResolvedValueOnce([
        {
          name: 'icon.png',
          isDirectory: () => false,
          isSymbolicLink: () => false,
          isFile: () => true
        },
        { name: 'fonts', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false }
      ])
      .mockResolvedValue([])

    const result = (await handlers.get('fs:importExternalPaths')!(null, {
      sourcePaths: [sourcePath],
      destDir
    })) as { results: { status: string; kind?: string }[] }

    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({
      status: 'imported',
      kind: 'directory',
      renamed: false
    })
    expect(mkdirMock).toHaveBeenCalled()
  })

  it('deconflicts top-level filename collisions', async () => {
    const sourcePath = '/tmp/dropped/logo.png'
    const existingDest = path.join(destDir, 'logo.png')
    lstatMock.mockImplementation(async (p: string) => {
      if (p === path.resolve(sourcePath)) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
      }
      if (p === existingDest) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
      }
      throw enoent()
    })

    const result = (await handlers.get('fs:importExternalPaths')!(null, {
      sourcePaths: [sourcePath],
      destDir
    })) as { results: { status: string; destPath?: string; renamed?: boolean }[] }

    expect(result.results[0]).toMatchObject({
      status: 'imported',
      destPath: path.join(destDir, 'logo copy.png'),
      renamed: true
    })
  })

  it('deconflicts top-level directory collisions', async () => {
    const sourcePath = '/tmp/dropped/assets'
    const existingDest = path.join(destDir, 'assets')
    lstatMock.mockImplementation(async (p: string) => {
      if (p === path.resolve(sourcePath)) {
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }
      }
      if (p === existingDest) {
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }
      }
      throw enoent()
    })
    readdirMock.mockResolvedValue([])

    const result = (await handlers.get('fs:importExternalPaths')!(null, {
      sourcePaths: [sourcePath],
      destDir
    })) as { results: { status: string; destPath?: string; renamed?: boolean }[] }

    expect(result.results[0]).toMatchObject({
      status: 'imported',
      destPath: path.join(destDir, 'assets copy'),
      renamed: true
    })
  })

  it('rejects top-level symlink sources before canonicalization', async () => {
    const sourcePath = '/tmp/dropped/link.txt'
    mockSymlinkSource(sourcePath)

    const result = (await handlers.get('fs:importExternalPaths')!(null, {
      sourcePaths: [sourcePath],
      destDir
    })) as { results: { status: string; reason?: string }[] }

    expect(result.results[0]).toMatchObject({ status: 'skipped', reason: 'symlink' })
    expect(copyFileMock).not.toHaveBeenCalled()
  })

  it('skips a dropped directory with nested symlinks without leaving partial output', async () => {
    const sourcePath = '/tmp/dropped/mixeddir'
    lstatMock.mockImplementation(async (p: string) => {
      if (p === path.resolve(sourcePath)) {
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }
      }
      throw enoent()
    })
    readdirMock.mockResolvedValue([
      {
        name: 'normal.txt',
        isDirectory: () => false,
        isSymbolicLink: () => false,
        isFile: () => true
      },
      {
        name: 'bad-link',
        isDirectory: () => false,
        isSymbolicLink: () => true,
        isFile: () => false
      }
    ])

    const result = (await handlers.get('fs:importExternalPaths')!(null, {
      sourcePaths: [sourcePath],
      destDir
    })) as { results: { status: string; reason?: string }[] }

    expect(result.results[0]).toMatchObject({ status: 'skipped', reason: 'symlink' })
    expect(copyFileMock).not.toHaveBeenCalled()
  })

  it('rejects unauthorized destinations', async () => {
    const sourcePath = '/tmp/dropped/file.txt'
    mockSourceFile(sourcePath)

    realpathMock.mockImplementation(async (p: string) => {
      if (p === path.resolve('/outside/evil')) {
        return path.resolve('/outside/evil')
      }
      return p
    })

    await expect(
      handlers.get('fs:importExternalPaths')!(null, {
        sourcePaths: [sourcePath],
        destDir: '/outside/evil'
      })
    ).rejects.toThrow('Access denied')
  })

  it('returns per-item results including rename metadata', async () => {
    const sources = ['/tmp/dropped/a.txt', '/tmp/dropped/missing.txt']
    lstatMock.mockImplementation(async (p: string) => {
      if (p === path.resolve(sources[0])) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
      }
      throw enoent()
    })

    const result = (await handlers.get('fs:importExternalPaths')!(null, {
      sourcePaths: sources,
      destDir
    })) as {
      results: {
        sourcePath: string
        status: string
        reason?: string
        renamed?: boolean
      }[]
    }

    expect(result.results).toHaveLength(2)
    expect(result.results[0]).toMatchObject({
      sourcePath: sources[0],
      status: 'imported',
      renamed: false
    })
    expect(result.results[1]).toMatchObject({
      sourcePath: sources[1],
      status: 'skipped',
      reason: 'missing'
    })
  })
})
