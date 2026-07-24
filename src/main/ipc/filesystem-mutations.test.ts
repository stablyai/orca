import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown>>()
const { handleMock, copyFileMock, lstatMock, mkdirMock, renameMock, writeFileMock, realpathMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    copyFileMock: vi.fn(),
    lstatMock: vi.fn(),
    mkdirMock: vi.fn(),
    renameMock: vi.fn(),
    writeFileMock: vi.fn(),
    realpathMock: vi.fn()
  }))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

vi.mock('fs/promises', () => ({
  lstat: lstatMock,
  mkdir: mkdirMock,
  rename: renameMock,
  writeFile: writeFileMock,
  realpath: realpathMock,
  copyFile: copyFileMock,
  readdir: vi.fn()
}))

import { registerFilesystemMutationHandlers } from './filesystem-mutations'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import {
  resetSshConnectionGenerations,
  setSshConnectionGeneration
} from '../ssh/ssh-connection-generation'

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

function mockStats(dev: number, ino: number) {
  return { dev, ino, isDirectory: () => false }
}

describe('registerFilesystemMutationHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    copyFileMock.mockReset()
    lstatMock.mockReset()
    mkdirMock.mockReset()
    renameMock.mockReset()
    writeFileMock.mockReset()
    realpathMock.mockReset()
    resetSshConnectionGenerations()

    handleMock.mockImplementation((channel: string, handler: never) => {
      handlers.set(channel, handler)
    })

    // By default, paths resolve to themselves and targets don't exist yet
    realpathMock.mockImplementation(async (p: string) => p)
    lstatMock.mockRejectedValue(enoent())
    mkdirMock.mockResolvedValue(undefined)
    writeFileMock.mockResolvedValue(undefined)
    renameMock.mockResolvedValue(undefined)
    copyFileMock.mockResolvedValue(undefined)

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

  it('rejects rename when destination already exists as a true collision', async () => {
    const oldPath = path.resolve('/workspace/repo/old.ts')
    const resolvedNewPath = path.resolve('/workspace/repo/new.ts')
    lstatMock.mockImplementation(async (p: string) => {
      if (p === oldPath) {
        return mockStats(1, 10)
      }
      if (p === resolvedNewPath) {
        return mockStats(1, 11)
      }
      throw enoent()
    })

    await expect(
      handlers.get('fs:rename')!(null, {
        oldPath,
        newPath: resolvedNewPath
      })
    ).rejects.toThrow("A file or folder named 'new.ts' already exists in this location")

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('allows case-only rename when destination is the same entry in the same parent', async () => {
    const oldPath = path.resolve('/workspace/repo/README.md')
    const newPath = path.resolve('/workspace/repo/readme.md')
    lstatMock.mockImplementation(async (p: string) => {
      if (p === oldPath || p === newPath) {
        return mockStats(2, 20)
      }
      throw enoent()
    })

    await handlers.get('fs:rename')!(null, { oldPath, newPath })

    expect(renameMock).toHaveBeenCalledWith(oldPath, newPath)
  })

  it('rejects hard-link alias rename collisions even when dev and ino match', async () => {
    const oldPath = path.resolve('/workspace/repo/README.md')
    const newPath = path.resolve('/workspace/repo/README-hardlink.md')
    lstatMock.mockImplementation(async (p: string) => {
      if (p === oldPath || p === newPath) {
        return mockStats(3, 30)
      }
      throw enoent()
    })

    await expect(handlers.get('fs:rename')!(null, { oldPath, newPath })).rejects.toThrow(
      "A file or folder named 'README-hardlink.md' already exists in this location"
    )

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects cross-parent case-only rename collisions even when dev and ino match', async () => {
    const oldPath = path.resolve('/workspace/repo/src/README.md')
    const newPath = path.resolve('/workspace/repo/docs/readme.md')
    lstatMock.mockImplementation(async (p: string) => {
      if (p === oldPath || p === newPath) {
        return mockStats(4, 40)
      }
      throw enoent()
    })

    await expect(handlers.get('fs:rename')!(null, { oldPath, newPath })).rejects.toThrow(
      "A file or folder named 'readme.md' already exists in this location"
    )

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects rename when parent directory escapes allowed roots', async () => {
    // Why: the parent is still canonicalized (preserveSymlink only preserves
    // the leaf). A symlinked ancestor that points outside allowed roots must
    // still be rejected so callers cannot redirect rename through it.
    mockRealpath({
      [path.resolve('/workspace/repo/escape-dir')]: path.resolve('/private/escape-dir')
    })

    await expect(
      handlers.get('fs:rename')!(null, {
        oldPath: path.resolve('/workspace/repo/old.ts'),
        newPath: path.resolve('/workspace/repo/escape-dir/new.ts')
      })
    ).rejects.toThrow('Access denied')

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('renames a symlink without following its target', async () => {
    // Why: rename must operate on the symlink entry, not its target —
    // following the link would rename the target file (possibly elsewhere in
    // the worktree, or outside allowed roots entirely). Even though the
    // symlink points at /private/secret.ts, renaming the link entry inside
    // the allowed root is a safe directory-entry mutation.
    mockRealpath({
      [path.resolve('/workspace/repo/symlink.ts')]: path.resolve('/private/secret.ts')
    })

    const oldPath = path.resolve('/workspace/repo/symlink.ts')
    const newPath = path.resolve('/workspace/repo/renamed-symlink.ts')
    await handlers.get('fs:rename')!(null, { oldPath, newPath })

    expect(renameMock).toHaveBeenCalledWith(oldPath, newPath)
  })

  it('routes rename through the SSH no-clobber filesystem provider when a connection is present', async () => {
    const renameNoClobber = vi.fn().mockResolvedValue(undefined)
    registerSshFilesystemProvider('ssh-1', { renameNoClobber } as never)

    try {
      await handlers.get('fs:rename')!(null, {
        oldPath: '/home/me/repo/old.ts',
        newPath: '/home/me/repo/new.ts',
        connectionId: 'ssh-1',
        expectedSshTargetId: 'ssh-1',
        expectedSshConnectionGeneration: 0
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(renameNoClobber).toHaveBeenCalledWith('/home/me/repo/old.ts', '/home/me/repo/new.ts')
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('propagates SSH no-clobber rename failures', async () => {
    const renameNoClobber = vi.fn().mockRejectedValue(new Error('destination exists'))
    registerSshFilesystemProvider('ssh-1', { renameNoClobber } as never)

    try {
      await expect(
        handlers.get('fs:rename')!(null, {
          oldPath: '/home/me/repo/old.ts',
          newPath: '/home/me/repo/new.ts',
          connectionId: 'ssh-1',
          expectedSshTargetId: 'ssh-1',
          expectedSshConnectionGeneration: 0
        })
      ).rejects.toThrow('destination exists')
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects direct SSH rename without target-bound generation provenance', async () => {
    const renameNoClobber = vi.fn().mockResolvedValue(undefined)
    registerSshFilesystemProvider('ssh-1', { renameNoClobber } as never)

    try {
      await expect(
        handlers.get('fs:rename')!(null, {
          oldPath: '/home/me/repo/old.ts',
          newPath: '/home/me/repo/new.ts',
          connectionId: 'ssh-1'
        })
      ).rejects.toThrow('SSH connection changed')
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(renameNoClobber).not.toHaveBeenCalled()
  })

  it('rejects equal-generation provenance for another direct SSH target', async () => {
    const renameNoClobber = vi.fn().mockResolvedValue(undefined)
    registerSshFilesystemProvider('ssh-b', { renameNoClobber } as never)

    try {
      await expect(
        handlers.get('fs:rename')!(null, {
          oldPath: '/home/me/repo/old.ts',
          newPath: '/home/me/repo/new.ts',
          connectionId: 'ssh-b',
          expectedSshTargetId: 'ssh-a',
          expectedSshConnectionGeneration: 0
        })
      ).rejects.toThrow('SSH connection changed')
    } finally {
      unregisterSshFilesystemProvider('ssh-b')
    }

    expect(renameNoClobber).not.toHaveBeenCalled()
  })

  it('rejects stale generation provenance for a direct SSH target', async () => {
    const renameNoClobber = vi.fn().mockResolvedValue(undefined)
    registerSshFilesystemProvider('ssh-1', { renameNoClobber } as never)
    setSshConnectionGeneration('ssh-1', 8)

    try {
      await expect(
        handlers.get('fs:rename')!(null, {
          oldPath: '/home/me/repo/old.ts',
          newPath: '/home/me/repo/new.ts',
          connectionId: 'ssh-1',
          expectedSshTargetId: 'ssh-1',
          expectedSshConnectionGeneration: 7
        })
      ).rejects.toThrow('SSH connection changed')
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(renameNoClobber).not.toHaveBeenCalled()
  })

  it('rejects stale SSH provenance when a direct mutation resolves local', async () => {
    await expect(
      handlers.get('fs:rename')!(null, {
        oldPath: path.resolve('/workspace/repo/old.ts'),
        newPath: path.resolve('/workspace/repo/new.ts'),
        expectedSshTargetId: 'ssh-1',
        expectedSshConnectionGeneration: 0
      })
    ).rejects.toThrow('SSH connection changed')

    expect(renameMock).not.toHaveBeenCalled()
  })

  it.each([
    ['fs:createFile', { filePath: path.resolve('/workspace/repo/new.ts') }],
    ['fs:createDir', { dirPath: path.resolve('/workspace/repo/new-dir') }],
    [
      'fs:rename',
      {
        oldPath: path.resolve('/workspace/repo/old.ts'),
        newPath: path.resolve('/workspace/repo/new.ts')
      }
    ],
    [
      'fs:copy',
      {
        sourcePath: path.resolve('/workspace/repo/source.ts'),
        destinationPath: path.resolve('/workspace/repo/copy.ts')
      }
    ],
    [
      'fs:importExternalPaths',
      { sourcePaths: [path.resolve('/tmp/source.ts')], destDir: path.resolve('/workspace/repo') }
    ],
    [
      'fs:resolveDroppedPathsForAgent',
      { paths: [path.resolve('/tmp/source.ts')], worktreePath: path.resolve('/workspace/repo') }
    ]
  ])(
    'rejects %s before local fallback when the expected execution host is SSH',
    async (channel, args) => {
      await expect(
        handlers.get(channel)!(null, { ...args, expectedExecutionHostId: 'ssh:ssh-1' })
      ).rejects.toThrow('Workspace host changed; refresh and try again')

      expect(writeFileMock).not.toHaveBeenCalled()
      expect(mkdirMock).not.toHaveBeenCalled()
      expect(renameMock).not.toHaveBeenCalled()
      expect(copyFileMock).not.toHaveBeenCalled()
    }
  )

  // ── fs:copy ────────────────────────────────────────────────────

  it('copies a file without overwriting an existing destination', async () => {
    const sourcePath = path.resolve('/workspace/repo/source.ts')
    const destinationPath = path.resolve('/workspace/repo/source copy.ts')

    await handlers.get('fs:copy')!(null, { sourcePath, destinationPath })

    expect(mkdirMock).toHaveBeenCalledWith(path.resolve('/workspace/repo'), { recursive: true })
    expect(copyFileMock).toHaveBeenCalledWith(sourcePath, destinationPath, expect.any(Number))
  })

  it('routes copy through the SSH filesystem provider when a connection is present', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    registerSshFilesystemProvider('ssh-1', { copy } as never)

    try {
      await handlers.get('fs:copy')!(null, {
        sourcePath: '/home/me/repo/source.ts',
        destinationPath: '/home/me/repo/source copy.ts',
        connectionId: 'ssh-1',
        expectedSshTargetId: 'ssh-1',
        expectedSshConnectionGeneration: 0
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(copy).toHaveBeenCalledWith('/home/me/repo/source.ts', '/home/me/repo/source copy.ts')
    expect(copyFileMock).not.toHaveBeenCalled()
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
