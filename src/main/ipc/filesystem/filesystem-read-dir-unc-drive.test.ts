import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  dirEntry,
  readdirMock,
  realpathMock,
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
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock('node:fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
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

import { PATH_OUTSIDE_ALLOWED_DIRECTORIES } from '../../../shared/local-file-access'
import { registerFilesystemHandlers } from './filesystem'
import {
  invalidateAuthorizedRootsCache,
  registerWorktreeRootsForRepo
} from '../registered-worktree-roots-cache'

function eperm(syscall: string, target: string): Error {
  return Object.assign(new Error(`EPERM: operation not permitted, ${syscall} '${target}'`), {
    code: 'EPERM'
  })
}

// Handler UNC authorization needs native Windows path resolution; runs in the Windows package lane.
describe.runIf(process.platform === 'win32')('fs:readDir on a UNC drive-mount project', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    invalidateAuthorizedRootsCache()
  })

  it('lists the folder through its drive path, since WSL refuses the UNC one', async () => {
    const unc = path.win32.join('\\\\wsl.localhost\\Ubuntu', 'mnt', 'c', 'src', 'app')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The harness store implements the accessors root registration reads.
    registerWorktreeRootsForRepo(store as never, 'repo-1', [unc])
    // WSL 2.7 answers EPERM for every Windows access to a drive mount over UNC.
    realpathMock.mockImplementation(async (target: string) => {
      if (target.startsWith('\\\\')) {
        throw eperm('realpath', target)
      }
      return target
    })
    readdirMock.mockImplementation(async (target: string) => {
      if (target.startsWith('\\\\')) {
        throw eperm('scandir', target)
      }
      return [dirEntry({ name: 'src', directory: true }), dirEntry({ name: 'README.md' })]
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The harness store implements the accessors these handlers read.
    registerFilesystemHandlers(store as never)

    await expect(handlers.get('fs:readDir')!(null, { dirPath: unc })).resolves.toEqual([
      { name: 'src', isDirectory: true, isSymlink: false },
      { name: 'README.md', isDirectory: false, isSymlink: false }
    ])
    expect(readdirMock).toHaveBeenCalledWith('C:\\src\\app', { withFileTypes: true })
  })

  it('still refuses a junction under the project that lands on another drive or outside it', async () => {
    const unc = path.win32.join('\\\\wsl.localhost\\Ubuntu', 'mnt', 'c', 'src', 'app')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The harness store implements the accessors root registration reads.
    registerWorktreeRootsForRepo(store as never, 'repo-1', [unc])
    const junctions: Record<string, string> = {
      'C:\\src\\app\\other-drive': 'D:\\elsewhere',
      'C:\\src\\app\\outside': 'C:\\Users\\me\\secrets'
    }
    realpathMock.mockImplementation(async (target: string) => {
      if (target.startsWith('\\\\')) {
        throw eperm('realpath', target)
      }
      return junctions[target] ?? target
    })
    readdirMock.mockResolvedValue([])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The harness store implements the accessors these handlers read.
    registerFilesystemHandlers(store as never)

    for (const name of ['other-drive', 'outside']) {
      await expect(
        handlers.get('fs:readDir')!(null, { dirPath: path.win32.join(unc, name) })
      ).rejects.toThrow(PATH_OUTSIDE_ALLOWED_DIRECTORIES)
    }
    expect(readdirMock).not.toHaveBeenCalled()
  })
})
