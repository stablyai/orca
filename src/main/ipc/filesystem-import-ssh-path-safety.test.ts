import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileUploadSession, IFilesystemProvider } from '../providers/types'

const { getConnMgrMock, lstatMock, providerMock, readdirMock, realpathMock } = vi.hoisted(() => ({
  getConnMgrMock: vi.fn(),
  lstatMock: vi.fn(),
  providerMock: vi.fn(),
  readdirMock: vi.fn(),
  realpathMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  readdir: readdirMock,
  realpath: realpathMock
}))
vi.mock('./filesystem-auth', () => ({
  authorizeExternalPath: vi.fn(),
  isENOENT: (error: NodeJS.ErrnoException) => error.code === 'ENOENT'
}))
vi.mock('./ssh', () => ({ getSshConnectionManager: getConnMgrMock }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: providerMock
}))

import { importExternalPathsSsh } from './filesystem-import-ssh'

function createProvider(uploadSession: FileUploadSession): IFilesystemProvider {
  const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  return {
    stat: vi.fn().mockRejectedValue(missing),
    createDirNoClobber: vi.fn().mockResolvedValue(undefined),
    deletePath: vi.fn().mockResolvedValue(undefined),
    openFileUploadSession: vi.fn().mockResolvedValue(uploadSession)
  } as unknown as IFilesystemProvider
}

describe('SSH import remote path safety', () => {
  const connectionId = 'ssh-windows'
  const destDir = 'C:/Users/me/project/.orca/drops'
  let provider: IFilesystemProvider
  let uploadSession: FileUploadSession

  beforeEach(() => {
    vi.clearAllMocks()
    getConnMgrMock.mockReturnValue({
      getConnection: () => ({ getState: () => ({ status: 'connected' }) })
    })
    uploadSession = {
      uploadFile: vi.fn().mockResolvedValue(undefined),
      close: vi.fn()
    }
    provider = createProvider(uploadSession)
    providerMock.mockReturnValue(provider)
    readdirMock.mockResolvedValue([])
    realpathMock.mockImplementation(async (value: string) => value)
  })

  it.runIf(process.platform !== 'win32')(
    'rejects a POSIX filename containing Windows traversal before remote stat',
    async () => {
      const sourcePath = '/tmp/..\\..\\.ssh\\orca_drop'

      const { results } = await importExternalPathsSsh([sourcePath], destDir, connectionId)

      expect(results[0]).toMatchObject({
        status: 'failed',
        reason: expect.stringContaining('Unsafe')
      })
      expect(lstatMock).not.toHaveBeenCalled()
      expect(provider.stat).not.toHaveBeenCalled()
      expect(provider.createDirNoClobber).not.toHaveBeenCalled()
      expect(uploadSession.uploadFile).not.toHaveBeenCalled()
      expect(provider.deletePath).not.toHaveBeenCalled()
    }
  )

  it.each(['report.txt:orca', 'NUL', 'trailing.', 'question?.txt'])(
    'rejects Windows-special top-level name %j before remote stat',
    async (name) => {
      const { results } = await importExternalPathsSsh([`/tmp/${name}`], destDir, connectionId)

      expect(results[0]).toMatchObject({
        status: 'failed',
        reason: expect.stringContaining('Unsafe')
      })
      expect(lstatMock).not.toHaveBeenCalled()
      expect(provider.stat).not.toHaveBeenCalled()
      expect(uploadSession.uploadFile).not.toHaveBeenCalled()
    }
  )

  it('rejects a nested Windows traversal name before creating the import root', async () => {
    const sourcePath = path.resolve('/tmp/assets')
    lstatMock.mockResolvedValue({
      isFile: () => false,
      isDirectory: () => true,
      isSymbolicLink: () => false
    })
    readdirMock.mockResolvedValue([
      {
        name: '..\\..\\.ssh\\orca_drop',
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }
    ])

    const { results } = await importExternalPathsSsh([sourcePath], destDir, connectionId)

    expect(results[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('Unsafe')
    })
    expect(provider.stat).not.toHaveBeenCalled()
    expect(provider.createDirNoClobber).not.toHaveBeenCalled()
    expect(uploadSession.uploadFile).not.toHaveBeenCalled()
    expect(provider.deletePath).not.toHaveBeenCalled()
  })

  it('keeps exclusive creation for safe file names', async () => {
    const sourcePath = path.resolve('/tmp/report.txt')
    lstatMock.mockResolvedValue({
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false
    })

    const { results } = await importExternalPathsSsh([sourcePath], destDir, connectionId)

    expect(results[0]).toMatchObject({ status: 'imported', destPath: `${destDir}/report.txt` })
    expect(uploadSession.uploadFile).toHaveBeenCalledWith(sourcePath, `${destDir}/report.txt`, {
      exclusive: true
    })
  })

  it.runIf(process.platform !== 'win32')(
    'preserves backslashes in valid POSIX names for POSIX remotes',
    async () => {
      const sourcePath = path.resolve('/tmp/notes\\2026.txt')
      const posixDestDir = '/home/me/project'
      lstatMock.mockResolvedValue({
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      })

      const { results } = await importExternalPathsSsh([sourcePath], posixDestDir, connectionId)

      expect(results[0]).toMatchObject({
        status: 'imported',
        destPath: `${posixDestDir}/notes\\2026.txt`
      })
      expect(uploadSession.uploadFile).toHaveBeenCalledWith(
        sourcePath,
        `${posixDestDir}/notes\\2026.txt`,
        { exclusive: true }
      )
    }
  )

  it('streams an N-file directory through guarded per-file uploads', async () => {
    const sourcePath = path.resolve('/tmp/assets')
    const names = ['one.txt', 'two.txt', 'three.txt']
    const entries = names.map((name) => ({
      name,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false
    }))
    lstatMock.mockImplementation(async (value: string) =>
      value === sourcePath
        ? { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }
        : { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
    )
    readdirMock.mockResolvedValue(entries)

    const { results } = await importExternalPathsSsh([sourcePath], destDir, connectionId)

    expect(results[0]).toMatchObject({ status: 'imported', kind: 'directory' })
    expect(uploadSession.uploadFile).toHaveBeenCalledTimes(3)
    for (const name of names) {
      expect(uploadSession.uploadFile).toHaveBeenCalledWith(
        path.join(sourcePath, name),
        `${destDir}/assets/${name}`,
        { exclusive: true }
      )
    }
  })

  it('skips special entries without failing the directory import', async () => {
    const sourcePath = path.resolve('/tmp/assets')
    const regularPath = path.join(sourcePath, 'report.txt')
    const socketPath = path.join(sourcePath, 'server.sock')
    const entries = [
      {
        name: 'report.txt',
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      },
      {
        name: 'server.sock',
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }
    ]
    lstatMock.mockImplementation(async (value: string) => {
      if (value === sourcePath) {
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }
      }
      if (value === regularPath) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
      }
      expect(value).toBe(socketPath)
      return { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false }
    })
    readdirMock.mockResolvedValue(entries)

    const { results } = await importExternalPathsSsh([sourcePath], destDir, connectionId)

    expect(results[0]).toMatchObject({ status: 'imported', kind: 'directory' })
    expect(uploadSession.uploadFile).toHaveBeenCalledOnce()
    expect(uploadSession.uploadFile).toHaveBeenCalledWith(
      regularPath,
      `${destDir}/assets/report.txt`,
      { exclusive: true }
    )
  })

  it('rejects a selected root replaced after its realpath is captured', async () => {
    const sourcePath = path.resolve('/tmp/assets')
    lstatMock.mockResolvedValue({
      isFile: () => false,
      isDirectory: () => true,
      isSymbolicLink: () => false
    })
    realpathMock.mockResolvedValueOnce(sourcePath).mockResolvedValueOnce('/private/replacement')

    const { results } = await importExternalPathsSsh([sourcePath], destDir, connectionId)

    expect(results[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('escapes selected directory')
    })
    expect(uploadSession.uploadFile).not.toHaveBeenCalled()
    expect(provider.deletePath).toHaveBeenCalledWith(`${destDir}/assets`, true)
  })

  it('rejects a selected root replaced while its realpath is captured', async () => {
    const sourcePath = path.resolve('/tmp/assets')
    const directoryStat = (ino: number) => ({
      dev: 1,
      ino,
      isFile: () => false,
      isDirectory: () => true,
      isSymbolicLink: () => false
    })
    lstatMock.mockResolvedValueOnce(directoryStat(1)).mockResolvedValueOnce(directoryStat(2))
    realpathMock.mockResolvedValue('/private/replacement')

    const { results } = await importExternalPathsSsh([sourcePath], destDir, connectionId)

    expect(results[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('changed while being inspected')
    })
    expect(provider.createDirNoClobber).not.toHaveBeenCalled()
    expect(uploadSession.uploadFile).not.toHaveBeenCalled()
    expect(provider.deletePath).not.toHaveBeenCalled()
  })
})
