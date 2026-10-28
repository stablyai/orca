import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  readdirMock,
  readFileMock,
  realpathMock,
  statMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

const diskPreconditionMock = vi.hoisted(() => ({ writeLocalTextFileWithDiskPrecondition: vi.fn() }))
vi.mock('./local-disk-write-precondition', () => diskPreconditionMock)
vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
const readStateMock = vi.hoisted(() =>
  vi.fn(async (_distro: string, _options?: unknown): Promise<string> => 'stopped')
)
vi.mock('../../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: readStateMock
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

import { registerFilesystemHandlers } from './filesystem'
import { WslDistroStoppedError, WslDistroUnverifiableError } from '../../wsl/wsl-unc-access-gate'

const UNC_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const UNC_FILE = `${UNC_ROOT}\\README.md`
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

async function invoke(channel: string, args: unknown): Promise<unknown> {
  return handlers.get(channel)!(null, args)
}

// A 9P touch of a stopped distro boots it (verify-15b 5e): background reads must refuse first.
describe('filesystem reads of a stopped WSL distro', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    readStateMock.mockReset().mockResolvedValue('stopped')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The harness store implements the accessors these handlers read.
    registerFilesystemHandlers(store as never)
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it.each([
    ['fs:readDir', { dirPath: UNC_ROOT }],
    ['fs:stat', { filePath: UNC_FILE }],
    ['fs:pathExists', { filePath: UNC_FILE }],
    ['fs:readFile', { filePath: UNC_FILE }],
    ['fs:readFileChunk', { filePath: UNC_FILE, offset: 0, length: 16 }],
    ['fs:listMarkdownDocuments', { rootPath: UNC_ROOT }]
  ])('%s refuses without a realpath, stat or read', async (channel, args) => {
    await expect(invoke(channel, args)).rejects.toBeInstanceOf(WslDistroStoppedError)
    expect(readStateMock).toHaveBeenCalledWith('Ubuntu', expect.anything())
    expect(realpathMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
    expect(readdirMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('fs:pathsExist answers no path of a stopped distro, rather than calling it absent', async () => {
    await expect(invoke('fs:pathsExist', { filePaths: [UNC_FILE] })).resolves.toEqual([
      { error: expect.stringContaining('is not running') }
    ])
    expect(realpathMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
  })

  it.each([
    ['fs:readDir', { dirPath: UNC_ROOT }],
    ['fs:readFile', { filePath: UNC_FILE }],
    ['fs:stat', { filePath: UNC_FILE }],
    ['fs:readFileChunk', { filePath: UNC_FILE, offset: 0, length: 16 }]
  ])('a user act (%s with wakeWslDistro) goes ahead without asking', async (channel, args) => {
    await invoke(channel, { ...args, wakeWslDistro: true }).catch((error: unknown) =>
      expect(error).not.toBeInstanceOf(WslDistroStoppedError)
    )
    expect(readStateMock).not.toHaveBeenCalled()
  })

  it("refuses with WSL didn't answer when the running list can't be read", async () => {
    readStateMock.mockResolvedValue('unverifiable')
    await expect(invoke('fs:readDir', { dirPath: UNC_ROOT })).rejects.toBeInstanceOf(
      WslDistroUnverifiableError
    )
    expect(realpathMock).not.toHaveBeenCalled()
  })

  it('a running distro reads as before', async () => {
    readStateMock.mockResolvedValue('running')
    await invoke('fs:stat', { filePath: UNC_FILE }).catch((error: unknown) =>
      expect(error).not.toBeInstanceOf(WslDistroStoppedError)
    )
    expect(readStateMock).toHaveBeenCalledTimes(1)
  })
})
