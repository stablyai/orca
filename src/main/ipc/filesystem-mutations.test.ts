import path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown>>()
const { handleMock, lstatMock, mkdirMock, renameMock, writeFileMock, realpathMock } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    lstatMock: vi.fn(),
    mkdirMock: vi.fn(),
    renameMock: vi.fn(),
    writeFileMock: vi.fn(),
    realpathMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

vi.mock('fs/promises', () => ({
  lstat: lstatMock,
  mkdir: mkdirMock,
  rename: renameMock,
  writeFile: writeFileMock,
  realpath: realpathMock,
  copyFile: vi.fn(),
  readdir: vi.fn()
}))

import { registerFilesystemMutationHandlers } from './filesystem-mutations'

// Why: paths are resolved via path.resolve() in production code, so test
// data must use resolved paths to avoid Unix-vs-Windows mismatches.
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

function mockRealpath(mapping: Record<string, string>) {
  realpathMock.mockImplementation(async (p: string) => {
    if (mapping[p]) {
      return mapping[p]
    }
    return p
  })
}

describe('registerFilesystemMutationHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    lstatMock.mockReset()
    mkdirMock.mockReset()
    renameMock.mockReset()
    writeFileMock.mockReset()
    realpathMock.mockReset()

    handleMock.mockImplementation((channel: string, handler: never) => {
      handlers.set(channel, handler)
    })

    // By default, paths resolve to themselves and targets don't exist yet
    realpathMock.mockImplementation(async (p: string) => p)
    lstatMock.mockRejectedValue(enoent())
    mkdirMock.mockResolvedValue(undefined)
    writeFileMock.mockResolvedValue(undefined)
    renameMock.mockResolvedValue(undefined)

    registerFilesystemMutationHandlers(store as never)
  })

  // ── fs:createFile ──────────────────────────────────────────────

  it('creates an empty file and its parent directories', async () => {
    const filePath = path.resolve('/workspace/repo/src/new.ts')
    await handlers.get('fs:createFile')!(null, { filePath })

    expect(mkdirMock).toHaveBeenCalledWith(path.resolve('/workspace/repo/src'), { recursive: true })
    expect(writeFileMock).toHaveBeenCalledWith(filePath, '', {
      encoding: 'utf-8',
      flag: 'wx'
    })
  })

  it('rejects file creation when path already exists (wx flag)', async () => {
    // The wx flag causes writeFile to throw EEXIST atomically, without a
    // separate lstat check — no TOCTOU race.
    writeFileMock.mockRejectedValue(Object.assign(new Error('EEXIST'), { code: 'EEXIST' }))

    await expect(
      handlers.get('fs:createFile')!(null, {
        filePath: path.resolve('/workspace/repo/existing.ts')
      })
    ).rejects.toThrow("A file or folder named 'existing.ts' already exists in this location")
  })

  it('rejects file creation outside allowed roots', async () => {
    mockRealpath({
      [path.resolve('/workspace/repo/link.ts')]: path.resolve('/private/secret.ts')
    })

    await expect(
      handlers.get('fs:createFile')!(null, { filePath: path.resolve('/workspace/repo/link.ts') })
    ).rejects.toThrow('Access denied')

    expect(writeFileMock).not.toHaveBeenCalled()
  })

  // ── fs:createDir ───────────────────────────────────────────────

  it('creates a directory recursively', async () => {
    const dirPath = path.resolve('/workspace/repo/src/components')
    await handlers.get('fs:createDir')!(null, { dirPath })

    expect(mkdirMock).toHaveBeenCalledWith(dirPath, { recursive: true })
  })

  it('rejects directory creation when path already exists', async () => {
    lstatMock.mockResolvedValue({ isDirectory: () => true })

    await expect(
      handlers.get('fs:createDir')!(null, { dirPath: path.resolve('/workspace/repo/src') })
    ).rejects.toThrow("A file or folder named 'src' already exists in this location")

    expect(mkdirMock).not.toHaveBeenCalled()
  })

  it('rejects directory creation outside allowed roots', async () => {
    mockRealpath({
      [path.resolve('/workspace/repo/escape')]: path.resolve('/etc/evil')
    })

    await expect(
      handlers.get('fs:createDir')!(null, { dirPath: path.resolve('/workspace/repo/escape') })
    ).rejects.toThrow('Access denied')

    expect(mkdirMock).not.toHaveBeenCalled()
  })

  // ── fs:rename ──────────────────────────────────────────────────

  it('renames a file within the same directory', async () => {
    const oldPath = path.resolve('/workspace/repo/old.ts')
    const newPath = path.resolve('/workspace/repo/new.ts')
    await handlers.get('fs:rename')!(null, { oldPath, newPath })

    expect(renameMock).toHaveBeenCalledWith(oldPath, newPath)
  })

  it('rejects rename when destination already exists', async () => {
    const resolvedNewPath = path.resolve('/workspace/repo/new.ts')
    lstatMock.mockImplementation(async (p: string) => {
      if (p === resolvedNewPath) {
        return { isDirectory: () => false }
      }
      throw enoent()
    })

    await expect(
      handlers.get('fs:rename')!(null, {
        oldPath: path.resolve('/workspace/repo/old.ts'),
        newPath: resolvedNewPath
      })
    ).rejects.toThrow("A file or folder named 'new.ts' already exists in this location")

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects rename when new path escapes allowed roots', async () => {
    mockRealpath({
      [path.resolve('/workspace/repo/escape.ts')]: path.resolve('/private/escape.ts')
    })

    await expect(
      handlers.get('fs:rename')!(null, {
        oldPath: path.resolve('/workspace/repo/old.ts'),
        newPath: path.resolve('/workspace/repo/escape.ts')
      })
    ).rejects.toThrow('Access denied')

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects rename when old path escapes allowed roots', async () => {
    mockRealpath({
      [path.resolve('/workspace/repo/symlink.ts')]: path.resolve('/private/secret.ts')
    })

    await expect(
      handlers.get('fs:rename')!(null, {
        oldPath: path.resolve('/workspace/repo/symlink.ts'),
        newPath: path.resolve('/workspace/repo/new.ts')
      })
    ).rejects.toThrow('Access denied')

    expect(renameMock).not.toHaveBeenCalled()
  })

  // ── Edge cases ─────────────────────────────────────────────────

  it('propagates non-ENOENT lstat errors in assertNotExists', async () => {
    lstatMock.mockRejectedValue(new Error('EPERM: operation not permitted'))

    await expect(
      handlers.get('fs:createDir')!(null, { dirPath: path.resolve('/workspace/repo/locked') })
    ).rejects.toThrow('EPERM')

    expect(mkdirMock).not.toHaveBeenCalled()
  })

  it('propagates mkdir permission errors for createFile', async () => {
    mkdirMock.mockRejectedValue(new Error('EACCES: permission denied'))

    await expect(
      handlers.get('fs:createFile')!(null, {
        filePath: path.resolve('/workspace/repo/nowrite/file.ts')
      })
    ).rejects.toThrow('EACCES')

    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('propagates fs.rename errors (e.g. ENOENT when source missing)', async () => {
    renameMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await expect(
      handlers.get('fs:rename')!(null, {
        oldPath: path.resolve('/workspace/repo/gone.ts'),
        newPath: path.resolve('/workspace/repo/new.ts')
      })
    ).rejects.toThrow('ENOENT')
  })
})
