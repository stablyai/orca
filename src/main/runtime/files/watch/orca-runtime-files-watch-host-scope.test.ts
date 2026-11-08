import { RuntimeFileWatches } from './file-watches'
import { describe, expect, it, vi } from 'vitest'
import { SshHostNotServedError } from '../../../providers/ssh-host-not-served-error'
import { watchInWatcherProcessMock, watchMock } from '../runtime-file-command-mock-registry'
import {
  createRuntimeFileHost,
  useRuntimeFileHostLifecycle
} from '../runtime-file-host.test-fixture'

vi.mock('fs', async () => (await import('../runtime-file-command-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('../runtime-file-command-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './file-watcher-host',
  async () => (await import('../runtime-file-command-mock-registry')).fileWatcherHostMock
)
vi.mock('../../../ipc/filesystem/access/filesystem-auth', async () =>
  (await import('../runtime-file-command-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../../../git/runner', async () =>
  (await import('../runtime-file-command-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../../../ipc/local-worktree-runtime-options',
  async () =>
    (await import('../runtime-file-command-mock-registry')).localWorktreeRuntimeOptionsMock
)

describe('RuntimeFileWatches', () => {
  useRuntimeFileHostLifecycle()

  it('refuses an SSH runtime watch without watching this machine', async () => {
    const { commands, store } = createFileWatches({ path: '/remote/repo' })
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

    await expect(commands.watchFileExplorer('id:wt-1', vi.fn())).rejects.toThrow(
      SshHostNotServedError
    )
    expect(watchInWatcherProcessMock).not.toHaveBeenCalled()
    expect(watchMock).not.toHaveBeenCalled()
  })
})

function createFileWatches(options?: Parameters<typeof createRuntimeFileHost>[0]) {
  const { host, store } = createRuntimeFileHost(options)
  return { commands: new RuntimeFileWatches(host), store }
}
