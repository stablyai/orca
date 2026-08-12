import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileUploadSession, IFilesystemProvider } from '../providers/types'

const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown>>()
const {
  handleMock,
  lstatMock,
  mkdirMock,
  realpathMock,
  copyFileMock,
  readdirMock,
  getConnMgrMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  lstatMock: vi.fn(),
  mkdirMock: vi.fn(),
  realpathMock: vi.fn(),
  copyFileMock: vi.fn(),
  readdirMock: vi.fn(),
  getConnMgrMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('fs/promises', () => ({
  lstat: lstatMock,
  mkdir: mkdirMock,
  rename: vi.fn(),
  writeFile: vi.fn(),
  realpath: realpathMock,
  copyFile: copyFileMock,
  readdir: readdirMock
}))
vi.mock('./ssh', () => ({ getSshConnectionManager: getConnMgrMock }))

import { registerFilesystemMutationHandlers } from './filesystem-mutations'
import {
  advanceSshConnectionGeneration,
  resetSshConnectionGenerations
} from '../ssh/ssh-connection-generation'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'

const store = {
  getRepos: () => [
    {
      id: 'r1',
      path: path.resolve('/workspace/repo'),
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0
    }
  ],
  getSettings: () => ({ workspaceDir: path.resolve('/workspace') })
}
const enoent = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

function createProvider(uploadSession: FileUploadSession): IFilesystemProvider {
  return {
    readDir: vi.fn(),
    readFile: vi.fn(),
    downloadFile: vi.fn(),
    openFileUploadSession: vi.fn().mockResolvedValue(uploadSession),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeFileBase64: vi.fn(),
    writeFileBase64Chunk: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockRejectedValue(enoent()),
    deletePath: vi.fn().mockResolvedValue(undefined),
    createFile: vi.fn(),
    createDir: vi.fn().mockResolvedValue(undefined),
    createDirNoClobber: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn(),
    renameNoClobber: vi.fn(),
    copy: vi.fn(),
    realpath: vi.fn(),
    search: vi.fn(),
    listFiles: vi.fn(),
    watch: vi.fn()
  } as unknown as IFilesystemProvider
}

describe('fs:importExternalPaths — SSH operations', () => {
  const destDir = '/home/user/project/src'
  const connId = 'ssh-conn-1'
  let provider: IFilesystemProvider
  let uploadSession: FileUploadSession
  const makeConn = () => ({
    getState: () => ({ status: 'connected' }),
    sftp: vi.fn()
  })
  const mockDir = (p: string): void => {
    const rp = path.resolve(p)
    lstatMock.mockImplementation(async (x: string) => {
      if (x === rp) {
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }
      }
      throw enoent()
    })
  }
  const mockFile = (p: string): void => {
    const rp = path.resolve(p)
    lstatMock.mockImplementation(async (x: string) => {
      if (x === rp) {
        return {
          size: 12,
          ino: 1,
          dev: 1,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false
        }
      }
      throw enoent()
    })
  }
  const invoke = (args: Record<string, unknown>) =>
    handlers.get('fs:importExternalPaths')!(null, {
      ...args,
      ...(typeof args.connectionId === 'string'
        ? {
            expectedSshTargetId: args.expectedSshTargetId ?? args.connectionId,
            expectedSshConnectionGeneration: args.expectedSshConnectionGeneration ?? 0
          }
        : {})
    }) as Promise<{
      results: Record<string, unknown>[]
    }>

  beforeEach(() => {
    handlers.clear()
    ;[
      handleMock,
      lstatMock,
      mkdirMock,
      realpathMock,
      copyFileMock,
      readdirMock,
      getConnMgrMock
    ].forEach((m) => m.mockReset())
    handleMock.mockImplementation((ch: string, h: never) => {
      handlers.set(ch, h)
    })
    realpathMock.mockImplementation(async (p: string) => p)
    lstatMock.mockRejectedValue(enoent())
    readdirMock.mockResolvedValue([])
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
    uploadSession = {
      uploadFile: vi.fn().mockResolvedValue(undefined),
      close: vi.fn()
    }
    provider = createProvider(uploadSession)
    registerSshFilesystemProvider(connId, provider)
    registerFilesystemMutationHandlers(store as never)
  })

  afterEach(() => {
    unregisterSshFilesystemProvider(connId)
    resetSshConnectionGenerations()
  })

  it('rejects a staged upload when a restarted HUB reaches the same target counter', async () => {
    resetSshConnectionGenerations(71)
    const stagedGeneration = advanceSshConnectionGeneration(connId)
    const sourcePath = path.resolve('/tmp/dropped/restart.txt')
    lstatMock.mockImplementation(async (candidate: string) => {
      if (candidate !== sourcePath) {
        throw enoent()
      }
      resetSshConnectionGenerations(72)
      advanceSshConnectionGeneration(connId)
      return {
        size: 12,
        ino: 1,
        dev: 1,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }
    })

    const { results } = await invoke({
      sourcePaths: [sourcePath],
      destDir,
      connectionId: connId,
      expectedSshTargetId: connId,
      expectedSshConnectionGeneration: stagedGeneration
    })

    expect(results[0]).toMatchObject({
      status: 'failed',
      reason: 'SSH connection changed; refresh and try again'
    })
    expect(uploadSession.uploadFile).not.toHaveBeenCalled()
  })

  it('deconflicts file names via provider stat', async () => {
    mockFile('/tmp/dropped/logo.png')
    vi.mocked(provider.stat).mockImplementation(async (p: string) => {
      if (p === `${destDir}/logo.png`) {
        return { type: 'file', size: 1, mtime: 1 }
      }
      throw enoent()
    })
    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/logo.png'],
      destDir,
      connectionId: connId
    })
    expect(results[0]).toMatchObject({
      status: 'imported',
      destPath: `${destDir}/logo copy.png`,
      renamed: true
    })
  })

  it('rejects symlink sources', async () => {
    const rp = path.resolve('/tmp/dropped/link.txt')
    lstatMock.mockImplementation(async (p: string) => {
      if (p === rp) {
        return { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true }
      }
      throw enoent()
    })
    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/link.txt'],
      destDir,
      connectionId: connId
    })
    expect(results[0]).toMatchObject({ status: 'skipped', reason: 'symlink' })
  })

  it('handles partial failure with correct per-item results', async () => {
    const sources = ['/tmp/dropped/good.txt', '/tmp/dropped/bad.txt', '/tmp/dropped/ok.txt']
    const resolved = new Set(sources.map((s) => path.resolve(s)))
    lstatMock.mockImplementation(async (p: string) => {
      if (resolved.has(p)) {
        return {
          size: 12,
          ino: 1,
          dev: 1,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false
        }
      }
      throw enoent()
    })
    vi.mocked(uploadSession.uploadFile).mockImplementation(async (_localPath, remotePath) => {
      if (remotePath.endsWith('/bad.txt')) {
        throw new Error('permission denied')
      }
    })

    const { results } = await invoke({ sourcePaths: sources, destDir, connectionId: connId })
    expect(results).toHaveLength(3)
    expect(results[0]).toMatchObject({ status: 'imported' })
    expect(results[1]).toMatchObject({ status: 'failed', reason: 'permission denied' })
    expect(results[2]).toMatchObject({ status: 'imported' })
    expect(provider.deletePath).not.toHaveBeenCalled()
  })

  it('does not delete a file another client created during an exclusive-upload race', async () => {
    mockFile('/tmp/dropped/report.txt')
    vi.mocked(uploadSession.uploadFile).mockRejectedValue(
      Object.assign(new Error('EEXIST: destination already exists'), { code: 'EEXIST' })
    )

    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/report.txt'],
      destDir,
      connectionId: connId
    })

    expect(results[0]).toMatchObject({
      status: 'failed',
      reason: 'EEXIST: destination already exists'
    })
    // Why: a failed exclusive create does not prove Orca owns the destination.
    expect(provider.deletePath).not.toHaveBeenCalled()
  })

  it('uploads directories via provider createDirNoClobber and binary writes', async () => {
    const root = path.resolve('/tmp/dropped/assets')
    const child = path.join(root, 'logo.png')
    lstatMock.mockImplementation(async (p: string) => {
      if (p === root) {
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }
      }
      if (p === child) {
        return {
          size: 3,
          ino: 1,
          dev: 1,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false
        }
      }
      throw enoent()
    })
    readdirMock.mockImplementation(async (p: string) =>
      p === root
        ? [
            {
              name: 'logo.png',
              isFile: () => true,
              isDirectory: () => false,
              isSymbolicLink: () => false
            }
          ]
        : []
    )
    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/assets'],
      destDir,
      connectionId: connId
    })

    expect(results[0]).toMatchObject({ status: 'imported', kind: 'directory' })
    expect(provider.createDirNoClobber).toHaveBeenCalledWith(`${destDir}/assets`)
    expect(uploadSession.uploadFile).toHaveBeenCalledWith(child, `${destDir}/assets/logo.png`, {
      exclusive: true
    })
  })

  it('reports per-item failure when deconfliction throws', async () => {
    mockFile('/tmp/dropped/file.txt')
    vi.mocked(provider.stat).mockRejectedValue(new Error('Remote connection not found'))
    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/file.txt'],
      destDir,
      connectionId: connId
    })
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'Remote connection not found' })
  })

  it('reports failure when creating a directory rejects', async () => {
    mockDir('/tmp/dropped/mydir')
    vi.mocked(provider.createDirNoClobber).mockRejectedValue(new Error('permission denied'))
    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/mydir'],
      destDir,
      connectionId: connId
    })
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'permission denied' })
  })

  it('removes a created SSH directory import root when nested upload fails', async () => {
    const root = path.resolve('/tmp/dropped/assets')
    const child = path.join(root, 'logo.png')
    lstatMock.mockImplementation(async (p: string) => {
      if (p === root) {
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }
      }
      if (p === child) {
        return {
          size: 3,
          ino: 1,
          dev: 1,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false
        }
      }
      throw enoent()
    })
    readdirMock.mockImplementation(async (p: string) =>
      p === root
        ? [
            {
              name: 'logo.png',
              isFile: () => true,
              isDirectory: () => false,
              isSymbolicLink: () => false
            }
          ]
        : []
    )
    vi.mocked(uploadSession.uploadFile).mockRejectedValue(new Error('disk full'))

    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/assets'],
      destDir,
      connectionId: connId
    })

    expect(results[0]).toMatchObject({ status: 'failed', reason: 'disk full' })
    expect(provider.createDirNoClobber).toHaveBeenCalledWith(`${destDir}/assets`)
    expect(provider.deletePath).toHaveBeenCalledWith(`${destDir}/assets`, true)
  })

  it('deconflicts directory names via provider stat', async () => {
    mockDir('/tmp/dropped/assets')
    vi.mocked(provider.stat).mockImplementation(async (p: string) => {
      if (p === `${destDir}/assets`) {
        return { type: 'directory', size: 1, mtime: 1 }
      }
      throw enoent()
    })
    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/assets'],
      destDir,
      connectionId: connId
    })
    expect(results[0]).toMatchObject({
      status: 'imported',
      destPath: `${destDir}/assets copy`,
      renamed: true
    })
  })

  it('rejects directory containing nested symlinks', async () => {
    mockDir('/tmp/dropped/project')
    const rd = path.resolve('/tmp/dropped/project')
    readdirMock.mockImplementation(async (p: string) => {
      if (p === rd) {
        return [
          {
            name: 'l.txt',
            isFile: () => false,
            isDirectory: () => false,
            isSymbolicLink: () => true
          }
        ]
      }
      return []
    })
    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/project'],
      destDir,
      connectionId: connId
    })
    expect(results[0]).toMatchObject({ status: 'skipped', reason: 'symlink' })
    expect(uploadSession.uploadFile).not.toHaveBeenCalled()
  })

  it('reports skipped when source lstat returns EACCES', async () => {
    const rp = path.resolve('/tmp/dropped/secret.txt')
    lstatMock.mockImplementation(async (p: string) => {
      if (p === rp) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      }
      throw enoent()
    })
    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/secret.txt'],
      destDir,
      connectionId: connId
    })
    expect(results[0]).toMatchObject({ status: 'skipped', reason: 'permission-denied' })
  })
})
