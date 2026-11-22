import path from 'node:path'

import { Readable, Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown>>()
const {
  handleMock,
  lstatMock,
  mkdirMock,
  realpathMock,
  copyFileMock,
  openMock,
  readFileMock,
  readdirMock,
  rmMock,
  unlinkMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  lstatMock: vi.fn(),
  mkdirMock: vi.fn(),
  realpathMock: vi.fn(),
  copyFileMock: vi.fn(),
  openMock: vi.fn(),
  readFileMock: vi.fn(),
  readdirMock: vi.fn(),
  rmMock: vi.fn(),
  unlinkMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/orca-test-user-data' },
  ipcMain: { handle: handleMock }
}))

vi.mock('fs/promises', () => ({
  lstat: lstatMock,
  mkdir: mkdirMock,
  open: openMock,
  rename: vi.fn(),
  writeFile: vi.fn(),
  realpath: realpathMock,
  copyFile: copyFileMock,
  readFile: readFileMock,
  readdir: readdirMock,
  rm: rmMock,
  unlink: unlinkMock
}))

import { registerFilesystemMutationHandlers } from '../mutations/filesystem-mutations'

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
  function mockLocalCopyOpenSuccess(content = Buffer.from('file-content')): void {
    openMock.mockImplementation(async (_p: string, flags: unknown) => {
      if (flags === 'wx') {
        const written: Buffer[] = []
        return {
          createWriteStream: () =>
            new Writable({
              write(chunk, _encoding, callback) {
                written.push(Buffer.from(chunk))
                callback()
              }
            }),
          close: vi.fn().mockResolvedValue(undefined),
          written
        }
      }
      return {
        stat: vi.fn().mockResolvedValue({
          size: content.byteLength,
          ino: 1,
          dev: 1,
          mtimeMs: 1700000000000,
          isFile: () => true
        }),
        createReadStream: () => Readable.from([content]),
        close: vi.fn().mockResolvedValue(undefined)
      }
    })
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    lstatMock.mockReset()
    mkdirMock.mockReset()
    realpathMock.mockReset()
    copyFileMock.mockReset()
    openMock.mockReset()
    readFileMock.mockReset()
    readdirMock.mockReset()
    rmMock.mockReset()
    unlinkMock.mockReset()

    handleMock.mockImplementation((channel: string, handler: never) => {
      handlers.set(channel, handler)
    })

    realpathMock.mockImplementation(async (p: string) => p)
    lstatMock.mockRejectedValue(enoent())
    mkdirMock.mockResolvedValue(undefined)
    copyFileMock.mockResolvedValue(undefined)
    mockLocalCopyOpenSuccess()
    readFileMock.mockResolvedValue(Buffer.from('file-content'))
    readdirMock.mockResolvedValue([])
    rmMock.mockResolvedValue(undefined)
    unlinkMock.mockResolvedValue(undefined)

    registerFilesystemMutationHandlers(store as never)
  })

  it('stages runtime upload directories whose child names start with dotdot characters', async () => {
    const sourcePath = '/tmp/dropped/project'
    const resolvedPath = path.resolve(sourcePath)
    const childDir = path.join(resolvedPath, '..assets')
    const childFile = path.join(childDir, 'icon.txt')
    lstatMock.mockImplementation(async (p: string) => {
      if (p === resolvedPath || p === childDir) {
        return {
          size: 0,
          ino: 1,
          dev: 1,
          mtimeMs: 1700000000000,
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false
        }
      }
      if (p === childFile) {
        return {
          size: 4,
          ino: 2,
          dev: 1,
          mtimeMs: 1700000000000,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false
        }
      }
      throw enoent()
    })
    readdirMock.mockImplementation(async (p: string) => {
      if (p === resolvedPath) {
        return [
          {
            name: '..assets',
            isDirectory: () => true,
            isSymbolicLink: () => false,
            isFile: () => false
          }
        ]
      }
      if (p === childDir) {
        return [
          {
            name: 'icon.txt',
            isDirectory: () => false,
            isSymbolicLink: () => false,
            isFile: () => true
          }
        ]
      }
      return []
    })
    openMock.mockResolvedValue({
      stat: vi.fn().mockResolvedValue({
        size: 4,
        ino: 2,
        dev: 1,
        mtimeMs: 1700000000000,
        isFile: () => true
      }),
      readFile: vi.fn().mockResolvedValue(Buffer.from('icon')),
      close: vi.fn().mockResolvedValue(undefined)
    })

    const result = (await handlers.get('fs:stageExternalPathsForRuntimeUpload')!(null, {
      sourcePaths: [sourcePath]
    })) as { sources: unknown[] }

    expect(result.sources).toEqual([
      {
        sourcePath,
        status: 'staged',
        name: 'project',
        kind: 'directory',
        entries: [
          { relativePath: '', kind: 'directory' },
          { relativePath: '..assets', kind: 'directory' },
          {
            relativePath: '..assets/icon.txt',
            kind: 'file',
            byteLength: 4,
            inode: 2,
            deviceId: 1,
            modifiedAtMs: 1700000000000
          }
        ]
      }
    ])
  })
})
