import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  localFileHandleMock,
  lstatMock,
  openMock,
  writeFileMock,
  realpathMock,
  statMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

const diskPreconditionMock = vi.hoisted(() => ({ writeLocalTextFileWithDiskPrecondition: vi.fn() }))
vi.mock('./local-disk-write-precondition', () => diskPreconditionMock)
vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
// The distro these UNC fixtures name counts as running, so the boot gate lets the touch through.
vi.mock('../../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: async () => 'running'
}))
const mkdirMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('fs/promises', async () => ({
  ...(await import('./filesystem-test-harness')).fsPromisesMock,
  mkdir: mkdirMock
}))
vi.mock('node:fs/promises', async () => ({
  ...(await import('./filesystem-test-harness')).fsPromisesMock,
  mkdir: mkdirMock
}))
vi.mock(
  '../../wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock(
  '../../git/status',
  async () => (await import('./filesystem-test-harness')).gitStatusModuleMock
)
vi.mock(
  '../../git/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)
vi.mock(
  '../../git/worktree',
  async () => (await import('./filesystem-test-harness')).gitWorktreeMock
)
vi.mock(
  '../../text-generation/commit-message-text-generation',
  async () => (await import('./filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../../text-generation/pull-request-context',
  async () => (await import('./filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../../source-control/pull-request-template',
  async () => (await import('./filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock(
  '../../source-control/pull-request-linked-issue',
  async () => (await import('./filesystem-test-harness')).pullRequestLinkedIssueMock
)

import { registerFilesystemHandlers } from './filesystem'
import {
  invalidateAuthorizedRootsCache,
  registerWorktreeRootsForRepo
} from '../registered-worktree-roots-cache'

function eperm(target: string): Error {
  return Object.assign(new Error(`EPERM: operation not permitted, '${target}'`), {
    code: 'EPERM'
  })
}

// WSL 2.7 answers EPERM for every Windows access to a drive mount over UNC.
function deniedOnUnc<T>(answer: (target: string) => T) {
  return async (target: string): Promise<T> => {
    if (target.startsWith('\\\\')) {
      throw eperm(target)
    }
    return answer(target)
  }
}

// Handler UNC authorization needs native Windows path resolution; runs in the Windows package lane.
describe.runIf(process.platform === 'win32')('editor IPC on a UNC drive-mount project', () => {
  const unc = path.win32.join('\\\\wsl.localhost\\Ubuntu', 'mnt', 'c', 'src', 'app')
  const readme = path.win32.join(unc, 'README.md')
  const fileStats = { size: 6, isFile: () => true, isDirectory: () => false, mtimeMs: 1 }

  beforeEach(() => {
    resetFilesystemIpcMocks()
    invalidateAuthorizedRootsCache()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The harness store implements the accessors root registration reads.
    registerWorktreeRootsForRepo(store as never, 'repo-1', [unc])
    realpathMock.mockImplementation(deniedOnUnc((target) => target))
    statMock.mockImplementation(deniedOnUnc(() => fileStats))
    lstatMock.mockImplementation(deniedOnUnc(() => fileStats))
    openMock.mockImplementation(deniedOnUnc(() => localFileHandleMock(Buffer.from('# app\n'))))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The harness store implements the accessors these handlers read.
    registerFilesystemHandlers(store as never)
  })

  it('opens, stats and checks a file through its drive path', async () => {
    await expect(handlers.get('fs:readFile')!(null, { filePath: readme })).resolves.toEqual({
      content: '# app\n',
      isBinary: false
    })
    await expect(handlers.get('fs:stat')!(null, { filePath: readme })).resolves.toMatchObject({
      size: 6,
      isDirectory: false
    })
    await expect(handlers.get('fs:pathExists')!(null, { filePath: readme })).resolves.toBe(true)
    await expect(
      handlers.get('fs:pathsExist')!(null, { filePaths: [readme] })
    ).resolves.toMatchObject([{ exists: true }])
    expect(openMock).toHaveBeenCalledWith('C:\\src\\app\\README.md', expect.anything())
  })

  it('saves through the drive path', async () => {
    await handlers.get('fs:writeFile')!(null, { filePath: readme, content: '# saved\n' })
    expect(lstatMock).toHaveBeenCalledWith('C:\\src\\app\\README.md')
    expect(diskPreconditionMock.writeLocalTextFileWithDiskPrecondition).toHaveBeenCalledWith(
      readme,
      '# saved\n',
      undefined
    )
  })

  it('creates a file and a folder, and saves a new file, where nothing exists yet', async () => {
    // Only the project folder exists; WSL still refuses every UNC access.
    const missing = (target: string): Error =>
      Object.assign(new Error(`ENOENT: no such file, '${target}'`), { code: 'ENOENT' })
    const onDisk = (target: string): boolean => target === 'C:\\src\\app'
    realpathMock.mockImplementation(
      deniedOnUnc((target) => {
        if (!onDisk(target)) {
          throw missing(target)
        }
        return target
      })
    )
    lstatMock.mockImplementation(
      deniedOnUnc((target) => {
        if (!onDisk(target)) {
          throw missing(target)
        }
        return { ...fileStats, isFile: () => false, isDirectory: () => true }
      })
    )
    const newFile = path.win32.join(unc, 'src', 'new.ts')

    await handlers.get('fs:createFile')!(null, { filePath: newFile })
    expect(writeFileMock).toHaveBeenCalledWith('C:\\src\\app\\src\\new.ts', '', {
      encoding: 'utf-8',
      flag: 'wx'
    })
    await handlers.get('fs:createDir')!(null, { dirPath: path.win32.join(unc, 'docs') })
    expect(mkdirMock).toHaveBeenCalledWith('C:\\src\\app\\docs', { recursive: true })
    await handlers.get('fs:writeFile')!(null, {
      filePath: path.win32.join(unc, 'notes.md'),
      content: 'hi'
    })
    expect(diskPreconditionMock.writeLocalTextFileWithDiskPrecondition).toHaveBeenCalledWith(
      path.win32.join(unc, 'notes.md'),
      'hi',
      undefined
    )
  })
})
