import { RuntimeFileReads } from './file-reads'
import { describe, expect, it, vi } from 'vitest'
import { openMock } from './runtime-file-command-mock-registry'
import {
  createRuntimeFileHost,
  useRuntimeFileHostLifecycle
} from './runtime-file-host.test-fixture'
import { SshHostNotServedError } from '../../providers/ssh-host-not-served-error'

vi.mock('fs', async () => (await import('./runtime-file-command-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./runtime-file-command-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './watch/file-watcher-host',
  async () => (await import('./runtime-file-command-mock-registry')).fileWatcherHostMock
)
vi.mock('../../ipc/filesystem/access/filesystem-auth', async () =>
  (await import('./runtime-file-command-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../../git/runner', async () =>
  (await import('./runtime-file-command-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../../ipc/local-worktree-runtime-options',
  async () => (await import('./runtime-file-command-mock-registry')).localWorktreeRuntimeOptionsMock
)

describe('RuntimeFileReads.readFileExplorerChunk', () => {
  useRuntimeFileHostLifecycle()

  it('refuses an SSH worktree without opening a local file', async () => {
    const { commands } = createFileReads({
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

function createFileReads(options?: Parameters<typeof createRuntimeFileHost>[0]) {
  const { host, store } = createRuntimeFileHost(options)
  return { commands: new RuntimeFileReads(host), store }
}
