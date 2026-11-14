import {
  createTerminalArtifactSubjects,
  absoluteFileTarget,
  useTerminalArtifactTempFiles
} from './orca-runtime-files-terminal-artifact-fixtures'
import { describe, expect, it, vi } from 'vitest'
import { realpath } from 'node:fs/promises'

import { useRuntimeFileHostLifecycle } from '../../files/runtime-file-host.test-fixture'
import { resolveAuthorizedPathMock, statMock } from '../../files/runtime-file-command-mock-registry'

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

describe('RuntimeTerminalArtifacts', () => {
  useRuntimeFileHostLifecycle()

  describe('resolveTerminalPath', () => {
    const { tempFile } = useTerminalArtifactTempFiles()

    // Why: a chat link or typed path carries no terminal; the caller's terminal access is the authority.
    it('grants a writable file outside every workspace with no terminal or chat context', async () => {
      const artifactPath = await tempFile('handoff.md', '# handoff')
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })

      const result = await paths.resolveTerminalPath(
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

    it('answers the root of a workspace nested inside the tapped one as that workspace', async () => {
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => true, size: 0, dev: 1, ino: 2, mtimeMs: 3 })
      const resolveKnownWorkspaceFileTarget = vi.fn(async (absolutePath: string) =>
        absolutePath === '/repo/worktrees/wt-2'
          ? {
              worktree: { id: 'wt-2', repoId: 'repo-1', path: '/repo/worktrees/wt-2' },
              executionHostId: 'local',
              relativePath: ''
            }
          : {
              worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo' },
              executionHostId: 'local',
              relativePath: 'src'
            }
      )
      const { paths } = createTerminalArtifactSubjects({
        path: '/repo',
        resolveKnownWorkspaceFileTarget
      })
      const resolve = (pathText: string) =>
        paths.resolveTerminalPath('id:wt-1', pathText, null, 'client-a', null, true)

      expect(await resolve('/repo/worktrees/wt-2')).toEqual({
        worktree: 'wt-2',
        relativePath: '',
        absolutePath: '/repo/worktrees/wt-2',
        exists: true,
        isDirectory: true
      })
      expect(await resolve('/repo/src')).toMatchObject({
        worktree: 'wt-1',
        relativePath: 'src',
        isDirectory: true
      })
    })

    // Why: procfs reports size 0 for files with content, so the grant digest cannot trust stat size.
    it.runIf(process.platform === 'linux')('reads a procfs file that reports size 0', async () => {
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })

      const target = absoluteFileTarget(
        await paths.resolveTerminalPath('id:wt-1', '/proc/version', null, 'client-a')
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
      const { paths } = createTerminalArtifactSubjects({ path: '/repo' })

      await expect(
        paths.resolveTerminalPath('id:wt-1', '/dev/null', null, 'client-a')
      ).rejects.toThrow('Not a regular file')
    })
  })
})
