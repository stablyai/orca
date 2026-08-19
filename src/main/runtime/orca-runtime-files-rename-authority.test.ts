import { describe, expect, it, vi } from 'vitest'
import {
  enoent,
  lstatMock,
  renameMock,
  resolveAuthorizedPathMock
} from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { setSshConnectionGeneration } from '../ssh/ssh-connection-generation'

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

function mockStats(dev: number, ino: number) {
  return { dev, ino, isDirectory: () => false }
}

function mockLocalPathStats(entries: Record<string, [number, number]>) {
  resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
  lstatMock.mockImplementation(async (p: string) => {
    const entry = entries[p]
    if (entry) {
      return mockStats(entry[0], entry[1])
    }
    throw enoent()
  })
}

describe('RuntimeFileCommands', () => {
  useRuntimeFileCommandsLifecycle()

  it('renames a runtime-local file when destination does not exist', async () => {
    const { commands } = createRuntimeFileCommands()
    resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

    await commands.renameFileExplorerPath(
      'id:wt-1',
      'old.ts',
      'new.ts',
      undefined,
      undefined,
      'local'
    )

    expect(renameMock).toHaveBeenCalledWith('/repo/old.ts', '/repo/new.ts')
  })

  it('rejects legacy paired local mutations before selecting a filesystem provider', async () => {
    const { commands } = createRuntimeFileCommands()

    await expect(commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts')).rejects.toThrow(
      'newer Orca client'
    )

    expect(getSshFilesystemProvider).not.toHaveBeenCalled()
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects legacy paired SSH mutations before selecting a filesystem provider', async () => {
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', 0, 'ssh-1')
    ).rejects.toThrow('newer Orca client')

    expect(getSshFilesystemProvider).not.toHaveBeenCalled()
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects a local expectation when the worktree moved to SSH', async () => {
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', undefined, undefined, 'local')
    ).rejects.toThrow('Workspace host changed')

    expect(getSshFilesystemProvider).not.toHaveBeenCalled()
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects an SSH expectation when the worktree moved to HUB-local', async () => {
    const { commands } = createRuntimeFileCommands()

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', 0, 'ssh-1', 'ssh:ssh-1')
    ).rejects.toThrow('Workspace host changed')

    expect(getSshFilesystemProvider).not.toHaveBeenCalled()
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('allows runtime-local case-only rename with IPC parity guard behavior', async () => {
    const { commands } = createRuntimeFileCommands()
    mockLocalPathStats({
      '/repo/README.md': [10, 100],
      '/repo/readme.md': [10, 100]
    })

    await commands.renameFileExplorerPath(
      'id:wt-1',
      'README.md',
      'readme.md',
      undefined,
      undefined,
      'local'
    )

    expect(renameMock).toHaveBeenCalledWith('/repo/README.md', '/repo/readme.md')
  })

  it('rejects runtime-local true destination collisions', async () => {
    const { commands } = createRuntimeFileCommands()
    mockLocalPathStats({
      '/repo/old.ts': [11, 110],
      '/repo/new.ts': [11, 111]
    })

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', undefined, undefined, 'local')
    ).rejects.toThrow("A file or folder named 'new.ts' already exists in this location")

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects runtime-local hard-link alias collisions', async () => {
    const { commands } = createRuntimeFileCommands()
    mockLocalPathStats({
      '/repo/README.md': [12, 120],
      '/repo/README-hardlink.md': [12, 120]
    })

    await expect(
      commands.renameFileExplorerPath(
        'id:wt-1',
        'README.md',
        'README-hardlink.md',
        undefined,
        undefined,
        'local'
      )
    ).rejects.toThrow("A file or folder named 'README-hardlink.md' already exists in this location")

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects runtime-local cross-parent case-only collisions', async () => {
    const { commands } = createRuntimeFileCommands()
    mockLocalPathStats({
      '/repo/src/README.md': [13, 130],
      '/repo/docs/readme.md': [13, 130]
    })

    await expect(
      commands.renameFileExplorerPath(
        'id:wt-1',
        'src/README.md',
        'docs/readme.md',
        undefined,
        undefined,
        'local'
      )
    ).rejects.toThrow("A file or folder named 'readme.md' already exists in this location")

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('routes runtime remote rename through the SSH no-clobber provider method', async () => {
    const renameNoClobber = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ renameNoClobber } as never)
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

    await commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', 0, 'ssh-1', 'ssh:ssh-1')

    expect(renameNoClobber).toHaveBeenCalledWith('/repo/old.ts', '/repo/new.ts')
    expect(store.getRepo).toHaveBeenCalledTimes(1)
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects a mutation captured for an obsolete SSH connection generation', async () => {
    const renameNoClobber = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ renameNoClobber } as never)
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
    setSshConnectionGeneration('ssh-1', 8)

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', 7, 'ssh-1', 'ssh:ssh-1')
    ).rejects.toThrow('SSH connection changed')
    expect(renameNoClobber).not.toHaveBeenCalled()
  })

  it('rejects nested SSH mutations from clients without generation support', async () => {
    const renameNoClobber = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ renameNoClobber } as never)
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

    await expect(
      commands.renameFileExplorerPath(
        'id:wt-1',
        'old.ts',
        'new.ts',
        undefined,
        'ssh-1',
        'ssh:ssh-1'
      )
    ).rejects.toThrow('SSH connection changed')
    expect(renameNoClobber).not.toHaveBeenCalled()
  })

  it('rejects an equal-generation mutation captured for another SSH target', async () => {
    const renameNoClobber = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ renameNoClobber } as never)
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-b' })

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', 0, 'ssh-a', 'ssh:ssh-a')
    ).rejects.toThrow('Workspace host changed')
    expect(getSshFilesystemProvider).not.toHaveBeenCalled()
    expect(renameNoClobber).not.toHaveBeenCalled()
  })

  it('rejects a stale SSH expectation after the worktree becomes HUB-local', async () => {
    const { commands } = createRuntimeFileCommands()

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', 0, 'ssh-1', 'ssh:ssh-1')
    ).rejects.toThrow('Workspace host changed')
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('propagates runtime remote no-clobber rename failures', async () => {
    const renameNoClobber = vi.fn().mockRejectedValue(new Error('destination exists'))
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ renameNoClobber } as never)
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', 0, 'ssh-1', 'ssh:ssh-1')
    ).rejects.toThrow('destination exists')
    expect(renameMock).not.toHaveBeenCalled()
  })
})
