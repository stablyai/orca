import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IFilesystemProvider } from '../providers/types'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import {
  convertRemoteFolderToGit,
  writeGitignoreExclusiveRemote
} from './convert-remote-folder-to-git'

const HOST = getRemoteHostPlatform('linux-x64')
const FOLDER = '/home/user/project'
const GIT_METADATA = `${FOLDER}/.git`

function missingPathError(): NodeJS.ErrnoException {
  return Object.assign(new Error('missing'), { code: 'ENOENT' })
}

type FilesystemOverrides = Partial<
  Pick<IFilesystemProvider, 'writeFile' | 'renameNoClobber' | 'deletePath'>
>

function makeFilesystem(
  existingPaths: Set<string>,
  overrides: FilesystemOverrides = {}
): IFilesystemProvider {
  return {
    lstat: vi.fn(async (path: string) => {
      if (!existingPaths.has(path)) {
        throw missingPathError()
      }
      return { size: 0, type: 'directory', mtime: 0 }
    }),
    stat: vi.fn(async (path: string) => {
      if (!existingPaths.has(path)) {
        throw missingPathError()
      }
      return { size: 0, type: 'directory', mtime: 0 }
    }),
    writeFile: vi.fn(async (path: string) => {
      existingPaths.add(path)
    }),
    renameNoClobber: vi.fn(async (from: string, to: string) => {
      if (existingPaths.has(to)) {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      }
      existingPaths.delete(from)
      existingPaths.add(to)
    }),
    deletePath: vi.fn(async (path: string) => {
      existingPaths.delete(path)
    }),
    ...overrides
  } as unknown as IFilesystemProvider
}

describe('convertRemoteFolderToGit cleanup ownership', () => {
  let existingPaths: Set<string>
  let fsProvider: IFilesystemProvider
  let exec: (
    args: string[],
    cwd: string,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ) => Promise<{ stdout: string; stderr: string }>

  beforeEach(() => {
    existingPaths = new Set([FOLDER])
    fsProvider = makeFilesystem(existingPaths)
    exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'init') {
        existingPaths.add(GIT_METADATA)
      }
      if (args[0] === 'commit') {
        throw new Error('commit failed')
      }
      return { stdout: '', stderr: '' }
    })
  })

  async function convert() {
    return convertRemoteFolderToGit({
      connectionId: 'ssh-1',
      path: FOLDER,
      host: HOST,
      fsProvider,
      gitProvider: {
        exec,
        isGitRepoAsync: vi.fn().mockResolvedValue({ isRepo: false, rootPath: null })
      }
    })
  }

  it('preserves repository metadata that existed before conversion', async () => {
    existingPaths.add(GIT_METADATA)

    await expect(convert()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('commit failed')
    })

    expect(existingPaths.has(GIT_METADATA)).toBe(true)
  })

  it('removes repository metadata created by a failed conversion', async () => {
    await expect(convert()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('commit failed')
    })

    expect(existingPaths.has(GIT_METADATA)).toBe(false)
    expect(fsProvider.deletePath).toHaveBeenCalledWith(GIT_METADATA, true)
  })

  it('removes partial repository metadata left by a failed git init', async () => {
    exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'init') {
        existingPaths.add(GIT_METADATA)
        throw new Error('init failed')
      }
      return { stdout: '', stderr: '' }
    })

    await expect(convert()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('init failed')
    })

    expect(existingPaths.has(GIT_METADATA)).toBe(false)
    expect(fsProvider.deletePath).toHaveBeenCalledWith(GIT_METADATA, true)
  })

  it('reports the conversion and cleanup failures together', async () => {
    fsProvider = makeFilesystem(existingPaths, {
      deletePath: vi.fn(async () => {
        throw new Error('permission denied')
      })
    })

    await expect(convert()).resolves.toEqual({
      ok: false,
      error:
        'Failed to create initial commit: commit failed. Failed to remove partial Git metadata: permission denied'
    })

    expect(existingPaths.has(GIT_METADATA)).toBe(true)
  })
})

describe('writeGitignoreExclusiveRemote', () => {
  const TMP = `${FOLDER}/.orca-gitignore.tmp`
  const GITIGNORE = `${FOLDER}/.gitignore`
  const CONTENT = '*.tmp\nnode_modules/\n'

  it('writes the tmp file then renameNoClobbers it into place without cleanup', async () => {
    const existingPaths = new Set<string>()
    const fsProvider = makeFilesystem(existingPaths)

    await writeGitignoreExclusiveRemote(fsProvider, TMP, GITIGNORE, CONTENT)

    expect(fsProvider.writeFile).toHaveBeenCalledWith(TMP, CONTENT)
    expect(fsProvider.renameNoClobber).toHaveBeenCalledWith(TMP, GITIGNORE)
    expect(fsProvider.deletePath).not.toHaveBeenCalled()
  })

  it('respects a .gitignore that appears before the final rename', async () => {
    const existingPaths = new Set<string>()
    const fsProvider = makeFilesystem(existingPaths)
    existingPaths.add(GITIGNORE)

    await expect(
      writeGitignoreExclusiveRemote(fsProvider, TMP, GITIGNORE, CONTENT)
    ).resolves.toBeUndefined()

    expect(fsProvider.writeFile).toHaveBeenCalledWith(TMP, CONTENT)
    expect(fsProvider.renameNoClobber).toHaveBeenCalledWith(TMP, GITIGNORE)
    expect(fsProvider.deletePath).toHaveBeenCalledWith(TMP, false)
    expect(existingPaths.has(GITIGNORE)).toBe(true)
  })

  it('rethrows non-EEXIST errors and still cleans up the tmp file', async () => {
    const existingPaths = new Set<string>()
    const unsafe = new Error(
      'Remote safe rename is unavailable. Reconnect the SSH target and retry.'
    )
    const fsProvider = makeFilesystem(existingPaths, {
      renameNoClobber: vi.fn().mockRejectedValue(unsafe)
    })

    await expect(
      writeGitignoreExclusiveRemote(fsProvider, TMP, GITIGNORE, CONTENT)
    ).rejects.toThrow('Remote safe rename is unavailable')

    expect(fsProvider.deletePath).toHaveBeenCalledWith(TMP, false)
  })

  it('cleans up the tmp file when writeFile fails and never calls rename', async () => {
    const existingPaths = new Set<string>()
    const fsProvider = makeFilesystem(existingPaths, {
      writeFile: vi.fn().mockRejectedValue(new Error('disk full'))
    })

    await expect(
      writeGitignoreExclusiveRemote(fsProvider, TMP, GITIGNORE, CONTENT)
    ).rejects.toThrow('disk full')

    expect(fsProvider.deletePath).toHaveBeenCalledWith(TMP, false)
    expect(fsProvider.renameNoClobber).not.toHaveBeenCalled()
  })

  it('rethrows the original error when tmp cleanup itself rejects', async () => {
    const existingPaths = new Set<string>()
    const fsProvider = makeFilesystem(existingPaths, {
      renameNoClobber: vi.fn().mockRejectedValue(new Error('rename boom')),
      deletePath: vi.fn().mockRejectedValue(new Error('cleanup failed'))
    })

    await expect(
      writeGitignoreExclusiveRemote(fsProvider, TMP, GITIGNORE, CONTENT)
    ).rejects.toThrow('rename boom')
  })
})
