import path from 'node:path'
import { constants } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileUploadSession, IFilesystemProvider } from '../providers/types'

const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown>>()
const {
  handleMock,
  lstatMock,
  mkdirMock,
  realpathMock,
  copyFileMock,
  openMock,
  readdirMock,
  unlinkMock,
  getConnMgrMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  lstatMock: vi.fn(),
  mkdirMock: vi.fn(),
  realpathMock: vi.fn(),
  copyFileMock: vi.fn(),
  openMock: vi.fn(),
  readdirMock: vi.fn(),
  unlinkMock: vi.fn(),
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
  open: openMock,
  readdir: readdirMock,
  unlink: unlinkMock,
  rm: vi.fn()
}))
vi.mock('./ssh', () => ({ getSshConnectionManager: getConnMgrMock }))

import { registerFilesystemMutationHandlers } from './filesystem-mutations'
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

describe('fs:importExternalPaths — SSH routing & connection', () => {
  const destDir = '/home/user/project/src'
  const connId = 'ssh-conn-1'
  let provider: IFilesystemProvider
  let uploadSession: FileUploadSession

  const makeConn = (status = 'connected') => ({
    getState: () => ({ status }),
    sftp: vi.fn()
  })
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
    handlers.get('fs:importExternalPaths')!(null, args) as Promise<{
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
      openMock,
      readdirMock,
      unlinkMock,
      getConnMgrMock
    ].forEach((m) => m.mockReset())
    handleMock.mockImplementation((ch: string, h: never) => {
      handlers.set(ch, h)
    })
    realpathMock.mockImplementation(async (p: string) => p)
    lstatMock.mockRejectedValue(enoent())
    openMock.mockImplementation(async (_p: string, flags: unknown) => {
      if (flags === 'wx') {
        return {
          createWriteStream: () =>
            new Writable({
              write(_chunk, _encoding, callback) {
                callback()
              }
            }),
          close: vi.fn().mockResolvedValue(undefined)
        }
      }
      return {
        stat: vi.fn().mockResolvedValue({
          size: 12,
          ino: 1,
          dev: 1,
          isFile: () => true
        }),
        createReadStream: () => Readable.from([Buffer.from('file-content')]),
        close: vi.fn().mockResolvedValue(undefined)
      }
    })
    unlinkMock.mockResolvedValue(undefined)
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
  })

  it('routes SSH imports through the filesystem provider when connectionId is present', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
    mockFile('/tmp/dropped/file.txt')

    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/file.txt'],
      destDir,
      connectionId: connId
    })

    expect(results[0]).toMatchObject({ status: 'imported', kind: 'file' })
    expect(uploadSession.uploadFile).toHaveBeenCalledWith(
      path.resolve('/tmp/dropped/file.txt'),
      `${destDir}/file.txt`,
      { exclusive: true }
    )
    expect(uploadSession.close).toHaveBeenCalledOnce()
    expect(copyFileMock).not.toHaveBeenCalled()
  })

  it('falls back to local import when connectionId is absent', async () => {
    mockFile('/tmp/dropped/file.txt')
    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/file.txt'],
      destDir: path.resolve('/workspace/repo/src')
    })
    expect(results[0]).toMatchObject({ status: 'imported' })
    expect(openMock).toHaveBeenCalledWith(
      path.resolve('/tmp/dropped/file.txt'),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    )
  })

  it('returns empty results without opening SFTP or requiring a provider', async () => {
    unregisterSshFilesystemProvider(connId)
    const conn = makeConn()
    getConnMgrMock.mockReturnValue({ getConnection: () => conn })
    const { results } = await invoke({ sourcePaths: [], destDir, connectionId: connId })
    expect(results).toHaveLength(0)
    expect(conn.sftp).not.toHaveBeenCalled()
  })

  it('throws when connectionId has no matching connection', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => null })
    await expect(
      invoke({ sourcePaths: ['/tmp/x'], destDir, connectionId: connId })
    ).rejects.toThrow('No SSH connection')
  })

  it('throws when connection is reconnecting', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn('reconnecting') })
    await expect(
      invoke({ sourcePaths: ['/tmp/x'], destDir, connectionId: connId })
    ).rejects.toThrow('reconnecting')
  })

  it('throws when connection is not active', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn('disconnected') })
    await expect(
      invoke({ sourcePaths: ['/tmp/x'], destDir, connectionId: connId })
    ).rejects.toThrow('not active')
  })

  it('throws when the SSH filesystem provider is unavailable', async () => {
    unregisterSshFilesystemProvider(connId)
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
    await expect(
      invoke({ sourcePaths: ['/tmp/x'], destDir, connectionId: connId })
    ).rejects.toThrow('Remote connection dropped')
  })

  it('uploads terminal-drop staging marker through provider writes', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
    mockFile('/tmp/dropped/file.txt')

    await invoke({
      sourcePaths: ['/tmp/dropped/file.txt'],
      destDir: '/home/user/project/.orca/drops',
      connectionId: connId,
      ensureDir: true
    })

    expect(provider.createDir).toHaveBeenCalledWith('/home/user/project/.orca')
    expect(provider.writeFile).toHaveBeenCalledWith(
      '/home/user/project/.orca/.gitignore',
      '*\n!.gitignore\n'
    )
    expect(provider.createDir).toHaveBeenCalledWith('/home/user/project/.orca/drops')
  })
})
