import { RuntimeTerminalPathResolver } from '../terminal-path-resolver'
import { RuntimeTerminalArtifacts } from './terminal-artifacts'
import { describe, expect, it, vi } from 'vitest'
import { realpath } from 'node:fs/promises'
import { statMock } from '../../files/runtime-file-command-mock-registry'
import {
  createRuntimeFileHost,
  useRuntimeFileHostLifecycle
} from '../../files/runtime-file-host.test-fixture'
import {
  resolveTerminalArtifactPath,
  useTerminalArtifactTempFiles
} from './orca-runtime-files-terminal-artifact-fixtures'

vi.mock('fs', async () =>
  (await import('../../files/runtime-file-command-mock-registry')).fsModuleMock()
)
vi.mock('fs/promises', async () =>
  (await import('../../files/runtime-file-command-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  '../../files/watch/file-watcher-host',
  async () => (await import('../../files/runtime-file-command-mock-registry')).fileWatcherHostMock
)
vi.mock('../../../ipc/filesystem/access/filesystem-auth', async () =>
  (await import('../../files/runtime-file-command-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../../../git/command-runner/host-routing/wsl-aware-spawn', async () =>
  (await import('../../files/runtime-file-command-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../../../ipc/local-worktree-runtime-options',
  async () =>
    (await import('../../files/runtime-file-command-mock-registry')).localWorktreeRuntimeOptionsMock
)

describe('RuntimeTerminalPathResolver', () => {
  useRuntimeFileHostLifecycle()

  describe('resolveTerminalPath', () => {
    const { tempFile } = useTerminalArtifactTempFiles()

    it('preserves host-qualified local POSIX terminal links from unverified OSC7 host metadata', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      const artifactPath = await tempFile('result.json', '{}')
      const resolveTerminalFileUriHostname = vi.fn(() => 'laptop.local')
      const { commands } = createTerminalPathResolver({
        path: '/repo',
        resolveTerminalFileUriHostname
      })

      const result = await resolveTerminalArtifactPath(commands, `//laptop.local${artifactPath}`)

      expect(resolveTerminalFileUriHostname).toHaveBeenCalledWith('term-1')
      expect(result).toMatchObject({
        relativePath: null,
        absolutePath: `//laptop.local${artifactPath}`,
        exists: false
      })
      expect(result.openTarget).toBeUndefined()
    })

    it('opens IPv4 loopback local POSIX terminal links as local paths', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      const artifactPath = await tempFile('result.json', '{}')
      const { commands } = createTerminalPathResolver({ path: '/repo' })
      const canonicalPath = await realpath(artifactPath)

      const result = await resolveTerminalArtifactPath(commands, `//127.0.0.1${artifactPath}`)

      expect(result).toMatchObject({
        relativePath: null,
        absolutePath: canonicalPath,
        exists: true,
        openTarget: {
          kind: 'absolute-file',
          provider: 'local',
          absolutePath: canonicalPath
        }
      })
    })

    it('refuses host-qualified terminal links on an SSH workspace instead of reading this machine', async () => {
      const resolveTerminalFileUriHostname = vi.fn(() => 'remote-host')
      const { commands, store } = createTerminalPathResolver({
        path: '/home/me/repo',
        resolveTerminalFileUriHostname
      })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

      await expect(
        resolveTerminalArtifactPath(commands, '//remote-host/tmp/result.json')
      ).rejects.toThrow('outside an SSH workspace')
      await expect(
        commands.resolveTerminalPath(
          'id:wt-1',
          '//remote-host/C:/Users/me/repo/src/app.ts',
          null,
          'client-a',
          'term-1'
        )
      ).rejects.toThrow('outside an SSH workspace')
      expect(statMock).not.toHaveBeenCalled()
    })
  })
})

function createTerminalPathResolver(options?: Parameters<typeof createRuntimeFileHost>[0]) {
  const { host, store } = createRuntimeFileHost(options)
  return {
    commands: new RuntimeTerminalPathResolver(host, new RuntimeTerminalArtifacts(host)),
    store
  }
}
