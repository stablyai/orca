import { RuntimeFileSearch } from './file-search'
import { describe, expect, it, vi } from 'vitest'
import { readdirMock, wslAwareSpawnMock } from '../runtime-file-command-mock-registry'
import {
  createRuntimeFileHost,
  useRuntimeFileHostLifecycle
} from '../runtime-file-host.test-fixture'

vi.mock('fs', async () => (await import('../runtime-file-command-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('../runtime-file-command-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  '../watch/file-watcher-host',
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
vi.mock('../../../ripgrep/bundled-ripgrep-path', async () =>
  (await import('../runtime-file-command-mock-registry')).bundledRipgrepPathModuleMock()
)
// Why: this process serves no SSH filesystem, so Quick Open on an `ssh:` workspace reports no
// matches (version 0) instead of failing the keystroke, and never lists this machine.
describe('runtime SSH Quick Open', () => {
  useRuntimeFileHostLifecycle()

  it('reports no matches and capability 0 without listing this machine', async () => {
    const { commands } = createFileSearch({ hostId: 'ssh:ssh-1' })

    await expect(commands.searchQuickOpenFilePaths('id:wt-1', 'target', 7)).resolves.toMatchObject({
      files: [],
      totalCount: 0,
      truncated: false,
      quickOpenSearchVersion: 0
    })
    await expect(
      commands.listRuntimeFiles('id:wt-1', { candidatePaths: ['recent.ts'], followSymlinks: true })
    ).resolves.toEqual([])
    await expect(commands.listMobileFiles('id:wt-1')).resolves.toMatchObject({
      files: [],
      totalCount: 0
    })
    expect(readdirMock).not.toHaveBeenCalled()
    expect(wslAwareSpawnMock).not.toHaveBeenCalled()
  })
})

function createFileSearch(options?: Parameters<typeof createRuntimeFileHost>[0]) {
  const { host, store } = createRuntimeFileHost(options)
  return { commands: new RuntimeFileSearch(host), store }
}
