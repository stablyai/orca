import { describe, expect, it, vi } from 'vitest'
import { openMock } from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

vi.mock('fs', async () => (await import('./orca-runtime-files-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./orca-runtime-files-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './file-watcher-host',
  async () => (await import('./orca-runtime-files-mock-registry')).fileWatcherHostMock
)
vi.mock('../ipc/filesystem/access/filesystem-auth', async () =>
  (await import('./orca-runtime-files-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./orca-runtime-files-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../ipc/local-worktree-runtime-options',
  async () => (await import('./orca-runtime-files-mock-registry')).localWorktreeRuntimeOptionsMock
)

describe('RuntimeFileCommands.readFileExplorerChunk', () => {
  useRuntimeFileCommandsLifecycle()

  it('refuses an SSH worktree without opening a local file', async () => {
    const { commands } = createRuntimeFileCommands({
      path: '/remote/repo',
      resolveRuntimeFileTarget: vi.fn(async () => ({
        worktree: { id: 'wt-1', repoId: 'repo-1', path: '/remote/repo' },
        executionHostId: 'ssh:ssh-1'
      }))
    })

    await expect(commands.readFileExplorerChunk('id:wt-1', 'big.bin', 0, 1024)).rejects.toThrow(
      SshHostNotServedError
    )
    expect(openMock).not.toHaveBeenCalled()
  })
})
