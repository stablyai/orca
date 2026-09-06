import { describe, expect, it, vi } from 'vitest'
import { resolveAuthorizedPathMock, statMock } from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import {
  absoluteFileTarget,
  resolveTerminalArtifactPath,
  useTerminalArtifactTempFiles
} from './orca-runtime-files-terminal-artifact-fixtures'

vi.mock('fs', async () => (await import('./orca-runtime-files-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./orca-runtime-files-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './file-watcher-host',
  async () => (await import('./orca-runtime-files-mock-registry')).fileWatcherHostMock
)
vi.mock('../ipc/filesystem-auth', async () =>
  (await import('./orca-runtime-files-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./orca-runtime-files-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../ipc/rg-availability',
  async () => (await import('./orca-runtime-files-mock-registry')).rgAvailabilityMock
)
vi.mock(
  '../ipc/local-worktree-runtime-options',
  async () => (await import('./orca-runtime-files-mock-registry')).localWorktreeRuntimeOptionsMock
)
vi.mock(
  '../ipc/filesystem-search-git',
  async () => (await import('./orca-runtime-files-mock-registry')).filesystemSearchGitMock
)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./orca-runtime-files-mock-registry')).sshFilesystemDispatchMock
)

describe('RuntimeFileCommands terminal artifact chunks', () => {
  useRuntimeFileCommandsLifecycle()
  const { tempFile } = useTerminalArtifactTempFiles()

  it('enforces exact grant ownership', async () => {
    const artifactPath = await tempFile('result.bin', 'abcdef')
    const { commands } = createRuntimeFileCommands({ path: '/repo' })
    resolveAuthorizedPathMock.mockImplementation(async (path: string) => path)
    statMock.mockResolvedValue({
      isDirectory: () => false,
      size: 6,
      dev: 1,
      ino: 2,
      mtimeMs: 3
    })
    const target = absoluteFileTarget(await resolveTerminalArtifactPath(commands, artifactPath))

    await expect(
      commands.readTerminalArtifactChunk(
        'id:wt-1',
        target.grantId,
        target.absolutePath,
        0,
        3,
        6,
        'client-b'
      )
    ).rejects.toThrow('terminal_file_grant_mismatch')
  })

  it('enforces the caller-provided artifact byte limit', async () => {
    const artifactPath = await tempFile('result.bin', 'abcdef')
    const { commands } = createRuntimeFileCommands({ path: '/repo' })
    resolveAuthorizedPathMock.mockImplementation(async (path: string) => path)
    statMock.mockResolvedValue({
      isDirectory: () => false,
      size: 6,
      dev: 1,
      ino: 2,
      mtimeMs: 3
    })
    const target = absoluteFileTarget(await resolveTerminalArtifactPath(commands, artifactPath))

    await expect(
      commands.readTerminalArtifactChunk(
        'id:wt-1',
        target.grantId,
        target.absolutePath,
        0,
        3,
        5,
        'client-a'
      )
    ).rejects.toThrow('file_too_large')
  })
})
