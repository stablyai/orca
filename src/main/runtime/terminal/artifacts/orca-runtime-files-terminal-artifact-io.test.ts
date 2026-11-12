import {
  createTerminalArtifactSubjects,
  absoluteFileTarget,
  resolveTerminalArtifactPath,
  useTerminalArtifactTempFiles
} from './orca-runtime-files-terminal-artifact-fixtures'
import { describe, expect, it, vi } from 'vitest'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  renameMock,
  resolveAuthorizedPathMock,
  statMock
} from '../../files/runtime-file-command-mock-registry'
import { useRuntimeFileHostLifecycle } from '../../files/runtime-file-host.test-fixture'

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

    it('reads an absolute terminal artifact only for the client that received the grant', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => false, size: 11, dev: 1, ino: 2, mtimeMs: 3 })

      const result = await resolveTerminalArtifactPath(paths, artifactPath)
      const target = absoluteFileTarget(result)

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).resolves.toMatchObject({
        relativePath: target.absolutePath,
        content: '{"ok":true}',
        truncated: false
      })
      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-b'
        )
      ).rejects.toThrow('terminal_file_grant_mismatch')
    })

    it('rejects stale absolute terminal artifact writes before changing the file', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(paths, artifactPath)
      const target = absoluteFileTarget(result)
      await rm(artifactPath)
      await writeFile(artifactPath, '{"ok":"ext"}')

      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          '{"ok":false}',
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe('{"ok":"ext"}')
    })

    it('lets only one of two concurrent writes from different clients land', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      // The registry stubs rename; commit for real so the second writer sees the first one's bytes.
      renameMock.mockImplementation(async (from, to) => writeFile(to, await readFile(from)))

      const first = absoluteFileTarget(await resolveTerminalArtifactPath(paths, artifactPath))
      const second = absoluteFileTarget(
        await resolveTerminalArtifactPath(paths, artifactPath, null, 'client-b')
      )

      const results = await Promise.allSettled([
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          first.grantId,
          first.absolutePath,
          '{"from":"a"}',
          'client-a'
        ),
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          second.grantId,
          second.absolutePath,
          '{"from":"b"}',
          'client-b'
        )
      ])

      const winner = results.findIndex((result) => result.status === 'fulfilled')
      expect(results[1 - winner]).toMatchObject({
        status: 'rejected',
        reason: new Error('terminal_file_grant_stale')
      })
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe(
        winner === 0 ? '{"from":"a"}' : '{"from":"b"}'
      )
    })

    it('keeps the original terminal artifact when atomic commit fails', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      renameMock.mockRejectedValueOnce(new Error('ENOSPC'))

      const result = await resolveTerminalArtifactPath(paths, artifactPath)
      const target = absoluteFileTarget(result)

      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          '{"ok":false}',
          'client-a'
        )
      ).rejects.toThrow('ENOSPC')
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe('{"ok":true}')
    })

    // Why: files above the digest cap are pinned by stat alone; utimes can restore mtime but never ctime.

    it('rejects retargeted symlink terminal artifact reads before returning outside content', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const outsidePath = join(artifactPath, '..', 'outside.json')
      await writeFile(outsidePath, '{"secret":true}')
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(paths, artifactPath)
      const target = absoluteFileTarget(result)
      await rm(artifactPath)
      await symlink(outsidePath, artifactPath)

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
    })

    it('rejects retargeted symlink terminal artifact writes before changing outside content', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const outsidePath = join(artifactPath, '..', 'outside.json')
      await writeFile(outsidePath, '{"secret":true}')
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(paths, artifactPath)
      const target = absoluteFileTarget(result)
      await rm(artifactPath)
      await symlink(outsidePath, artifactPath)

      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          '{"ok":false}',
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
      await expect(readFile(outsidePath, 'utf8')).resolves.toBe('{"secret":true}')
    })

    it('rejects binary-extension terminal artifacts from the editable text path', async () => {
      const artifactPath = await tempFile('report.pdf', '%PDF text-looking bytes')
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({
        isDirectory: () => false,
        size: 23,
        dev: 1,
        ino: 2,
        mtimeMs: 3
      })

      const result = await resolveTerminalArtifactPath(paths, artifactPath)
      const target = absoluteFileTarget(result)

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('binary_file')
      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'not a pdf',
          'client-a'
        )
      ).rejects.toThrow('binary_file')
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe('%PDF text-looking bytes')
    })
  })
})
