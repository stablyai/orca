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

describe('fs:importExternalPaths — SSH operations', () => {
  const destDir = '/home/user/project/src'
  const connId = 'ssh-conn-1'
  const mockSftp = { end: vi.fn() }
  const makeConn = () => ({
    getState: () => ({ status: 'connected' }),
    sftp: vi.fn().mockResolvedValue(mockSftp)
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
    getConnMgrMock.mockReturnValue({ getConnection: () => makeConn() })
    registerFilesystemMutationHandlers(store as never)
  })

  it('deconflicts file names via SFTP lstat', async () => {
    const rp = path.resolve('/tmp/dropped/logo.png')
    lstatMock.mockImplementation(async (x: string) => {
      if (x === rp) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
      }
      throw enoent()
    })
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
    mockDir('/tmp/dropped/assets')
    readdirMock.mockResolvedValue([])
    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/assets'],
      destDir,
      connectionId: connId
    })
    expect(results[0]).toMatchObject({ status: 'imported', kind: 'directory' })
    expect(mkdirSftpMock).toHaveBeenCalledWith(mockSftp, `${destDir}/assets`)
  })

  it('reports per-item failure when deconfliction throws', async () => {
    const rp = path.resolve('/tmp/dropped/file.txt')
    lstatMock.mockImplementation(async (x: string) => {
      if (x === rp) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
      }
      throw enoent()
    })
    sftpExistsMock.mockRejectedValue(new Error('SFTP channel closed'))
    const { results } = await invoke({
      sourcePaths: ['/tmp/dropped/file.txt'],
      destDir,
      connectionId: connId
    })
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'SFTP channel closed' })
  })

  it('reports failure when mkdirSftp rejects', async () => {
    mockDir('/tmp/dropped/mydir')
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
    mockDir('/tmp/dropped/assets')
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
    expect(uploadDirMock).not.toHaveBeenCalled()
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
