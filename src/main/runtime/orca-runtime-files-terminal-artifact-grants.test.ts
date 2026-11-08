import { describe, expect, it, vi } from 'vitest'
import { realpath } from 'node:fs/promises'

import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import {
  absoluteFileTarget,
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

describe('RuntimeFileCommands', () => {
  useRuntimeFileCommandsLifecycle()

  describe('resolveTerminalPath', () => {
    const { tempFile } = useTerminalArtifactTempFiles()

    // Why: a chat link or typed path carries no terminal; the caller's terminal access is the authority.
    it('grants a writable file outside every workspace with no terminal or chat context', async () => {
      const artifactPath = await tempFile('handoff.md', '# handoff')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        artifactPath,
        null,
        'client-a',
        null,
        true
      )

      expect(result).toMatchObject({
        relativePath: null,
        absolutePath: await realpath(artifactPath),
        exists: true,
        isDirectory: false,
        openTarget: { kind: 'absolute-file', provider: 'local' }
      })
      const target = absoluteFileTarget(result)
      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).resolves.toMatchObject({ content: '# handoff' })
      // Why: chat-cited grants used to be read-only; the caller may already write this file.
      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          '# changed',
          'client-a'
        )
      ).resolves.toEqual({ ok: true })
    })

    // Why: procfs reports size 0 for files with content, so the grant digest cannot trust stat size.
    it.runIf(process.platform === 'linux')('reads a procfs file that reports size 0', async () => {
      const { commands } = createRuntimeFileCommands({ path: '/repo' })

      const target = absoluteFileTarget(
        await commands.resolveTerminalPath('id:wt-1', '/proc/version', null, 'client-a')
      )

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).resolves.toMatchObject({ content: expect.stringContaining('Linux') })
    })

    // Why: opening a FIFO or device blocking would stall a host threadpool thread.
    it.skipIf(process.platform === 'win32')('refuses a device instead of granting it', async () => {
      const { commands } = createRuntimeFileCommands({ path: '/repo' })

      await expect(
        commands.resolveTerminalPath('id:wt-1', '/dev/null', null, 'client-a')
      ).rejects.toThrow('Not a regular file')
    })
  })
})
