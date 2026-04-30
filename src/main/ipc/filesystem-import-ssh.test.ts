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

describe('fs:importExternalPaths (SSH)', () => {
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
    const conn = makeConn()
    getConnMgrMock.mockReturnValue({ getConnection: () => conn })
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
    const localDest = path.resolve('/workspace/repo/src')
    mockFile('/tmp/dropped/file.txt')
    const { results } = await invoke({ sourcePaths: ['/tmp/dropped/file.txt'], destDir: localDest })
    expect(results[0]).toMatchObject({ status: 'imported' })
    expect(copyFileMock).toHaveBeenCalled()
    expect(uploadFileMock).not.toHaveBeenCalled()
  })

  it('returns empty results for empty sourcePaths without opening SFTP', async () => {
    const conn = makeConn()
    getConnMgrMock.mockReturnValue({ getConnection: () => conn })
    const { results } = await invoke({ sourcePaths: [], destDir, connectionId: connId })
    expect(results).toHaveLength(0)
    expect(conn.sftp).not.toHaveBeenCalled()
  })

  it('throws when connectionId has no matching SSH connection', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => null })
    await expect(
      invoke({ sourcePaths: ['/tmp/x'], destDir, connectionId: connId })
    ).rejects.toThrow('No SSH connection')
  })

  it('throws user-friendly error when connection is reconnecting', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn('reconnecting') })
    await expect(
      invoke({ sourcePaths: ['/tmp/x'], destDir, connectionId: connId })
    ).rejects.toThrow('SSH connection is reconnecting')
  })

  it('throws when connection is not active', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn('disconnected') })
    await expect(
      invoke({ sourcePaths: ['/tmp/x'], destDir, connectionId: connId })
    ).rejects.toThrow('SSH connection is not active')
  })

  it('closes SFTP channel after import completes', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
    mockFile('/tmp/dropped/file.txt')
    await invoke({ sourcePaths: ['/tmp/dropped/file.txt'], destDir, connectionId: connId })
    expect(mockSftp.end).toHaveBeenCalledOnce()
  })

  it('closes SFTP channel even when upload throws', async () => {
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

  it('deconflicts file names via SFTP lstat', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
    mockFile('/tmp/dropped/logo.png')
    sftpExistsMock.mockImplementation(async (_s: unknown, p: string) => p === `${destDir}/logo.png`)
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
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
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
    expect(uploadFileMock).not.toHaveBeenCalled()
  })

  it('handles partial failure with correct per-item results', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
    const sources = ['/tmp/dropped/good.txt', '/tmp/dropped/bad.txt', '/tmp/dropped/ok.txt']
    lstatMock.mockImplementation(async (p: string) => {
      if (sources.map((s) => path.resolve(s)).includes(p)) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
      }
      throw enoent()
    })
    uploadFileMock.mockImplementation(async (_s: unknown, lp: string) => {
      if (lp === path.resolve('/tmp/dropped/bad.txt')) {
        throw new Error('permission denied')
      }
    })
    const { results } = await invoke({ sourcePaths: sources, destDir, connectionId: connId })
    expect(results).toHaveLength(3)
    expect(results[0]).toMatchObject({ status: 'imported' })
    expect(results[1]).toMatchObject({ status: 'failed', reason: 'permission denied' })
    expect(results[2]).toMatchObject({ status: 'imported' })
  })

  it('uploads directories via mkdirSftp + uploadDirectory', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
    const rd = path.resolve('/tmp/dropped/assets')
    lstatMock.mockImplementation(async (p: string) => {
      if (p === rd) {
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }
      }
      throw enoent()
    })
    readdirMock.mockResolvedValue([])
    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/assets'],
      destDir,
      connectionId: connId
    })
    expect(results[0]).toMatchObject({ status: 'imported', kind: 'directory' })
    expect(mkdirSftpMock).toHaveBeenCalledWith(mockSftp, `${destDir}/assets`)
    expect(uploadDirMock).toHaveBeenCalledWith(mockSftp, rd, `${destDir}/assets`)
  })

  it('throws when conn.sftp() rejects', async () => {
    const conn = makeConn()
    conn.sftp.mockRejectedValue(new Error('SFTP subsystem not available'))
    getConnMgrMock.mockReturnValue({ getConnection: () => conn })
    await expect(
      invoke({ sourcePaths: ['/tmp/x'], destDir, connectionId: connId })
    ).rejects.toThrow('SFTP subsystem not available')
  })

  it('reports per-item failure when deconfliction throws', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
    mockFile('/tmp/dropped/file.txt')
    sftpExistsMock.mockRejectedValue(new Error('SFTP channel closed'))
    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/file.txt'],
      destDir,
      connectionId: connId
    })
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'SFTP channel closed' })
    expect(mockSftp.end).toHaveBeenCalledOnce()
  })

  it('reports failure when mkdirSftp rejects', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
    const rd = path.resolve('/tmp/dropped/mydir')
    lstatMock.mockImplementation(async (p: string) => {
      if (p === rd) {
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }
      }
      throw enoent()
    })
    readdirMock.mockResolvedValue([])
    mkdirSftpMock.mockRejectedValue(new Error('permission denied'))
    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/mydir'],
      destDir,
      connectionId: connId
    })
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'permission denied' })
  })

  it('deconflicts directory names via SFTP lstat', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
    const rd = path.resolve('/tmp/dropped/assets')
    lstatMock.mockImplementation(async (p: string) => {
      if (p === rd) {
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }
      }
      throw enoent()
    })
    readdirMock.mockResolvedValue([])
    sftpExistsMock.mockImplementation(async (_s: unknown, p: string) => p === `${destDir}/assets`)
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
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
    const rd = path.resolve('/tmp/dropped/project')
    lstatMock.mockImplementation(async (p: string) => {
      if (p === rd) {
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }
      }
      throw enoent()
    })
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
    expect(uploadDirMock).not.toHaveBeenCalled()
  })

  it('reports skipped when source lstat returns EACCES', async () => {
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
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
