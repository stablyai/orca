import path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown>>()
const {
  handleMock,
  lstatMock,
  mkdirMock,
  realpathMock,
  copyFileMock,
  readdirMock,
  sftpExistsMock,
  uploadFileMock,
  uploadDirMock,
  mkdirSftpMock,
  getConnMgrMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  lstatMock: vi.fn(),
  mkdirMock: vi.fn(),
  realpathMock: vi.fn(),
  copyFileMock: vi.fn(),
  readdirMock: vi.fn(),
  sftpExistsMock: vi.fn(),
  uploadFileMock: vi.fn(),
  uploadDirMock: vi.fn(),
  mkdirSftpMock: vi.fn(),
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
vi.mock('../ssh/sftp-upload', () => ({
  sftpPathExists: sftpExistsMock,
  uploadFile: uploadFileMock,
  uploadDirectory: uploadDirMock,
  mkdirSftp: mkdirSftpMock
}))
vi.mock('./ssh', () => ({ getSshConnectionManager: getConnMgrMock }))

import { registerFilesystemMutationHandlers } from './filesystem-mutations'

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

describe('fs:importExternalPaths — SSH routing & connection', () => {
  const destDir = '/home/user/project/src'
  const connId = 'ssh-conn-1'
  const mockSftp = { end: vi.fn() }
  const makeConn = (status = 'connected') => ({
    getState: () => ({ status }),
    sftp: vi.fn().mockResolvedValue(mockSftp)
  })
  const mockFile = (p: string): void => {
    const rp = path.resolve(p)
    lstatMock.mockImplementation(async (x: string) => {
      if (x === rp) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
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
      readdirMock,
      sftpExistsMock,
      uploadFileMock,
      uploadDirMock,
      mkdirSftpMock,
      getConnMgrMock
    ].forEach((m) => m.mockReset())
    mockSftp.end.mockReset()
    handleMock.mockImplementation((ch: string, h: never) => {
      handlers.set(ch, h)
    })
    realpathMock.mockImplementation(async (p: string) => p)
    lstatMock.mockRejectedValue(enoent())
    sftpExistsMock.mockResolvedValue(false)
    uploadFileMock.mockResolvedValue(undefined)
    uploadDirMock.mockResolvedValue(undefined)
    mkdirSftpMock.mockResolvedValue(undefined)
    registerFilesystemMutationHandlers(store as never)
  })

  it('routes to SFTP when connectionId is present', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
    mockFile('/tmp/dropped/file.txt')
    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/file.txt'],
      destDir,
      connectionId: connId
    })
    expect(results[0]).toMatchObject({ status: 'imported', kind: 'file' })
    expect(uploadFileMock).toHaveBeenCalled()
    expect(copyFileMock).not.toHaveBeenCalled()
  })

  it('falls back to local import when connectionId is absent', async () => {
    mockFile('/tmp/dropped/file.txt')
    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/file.txt'],
      destDir: path.resolve('/workspace/repo/src')
    })
    expect(results[0]).toMatchObject({ status: 'imported' })
    expect(copyFileMock).toHaveBeenCalled()
  })

  it('returns empty results without opening SFTP', async () => {
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

  it('throws when conn.sftp() rejects', async () => {
    const conn = makeConn()
    conn.sftp.mockRejectedValue(new Error('SFTP subsystem not available'))
    getConnMgrMock.mockReturnValue({ getConnection: () => conn })
    await expect(
      invoke({ sourcePaths: ['/tmp/x'], destDir, connectionId: connId })
    ).rejects.toThrow('SFTP subsystem')
  })

  it('closes SFTP channel after success', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
    mockFile('/tmp/dropped/file.txt')
    await invoke({ sourcePaths: ['/tmp/dropped/file.txt'], destDir, connectionId: connId })
    expect(mockSftp.end).toHaveBeenCalledOnce()
  })

  it('closes SFTP channel after upload error', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
    mockFile('/tmp/dropped/file.txt')
    uploadFileMock.mockRejectedValue(new Error('disk full'))
    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/file.txt'],
      destDir,
      connectionId: connId
    })
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'disk full' })
    expect(mockSftp.end).toHaveBeenCalledOnce()
  })
})
