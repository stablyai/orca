import { describe, expect, it, vi } from 'vitest'
import { link, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renameMock, resolveAuthorizedPathMock, statMock } from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import {
  absoluteFileTarget,
  resolveTerminalArtifactPath,
  useTerminalArtifactTempFiles
} from './orca-runtime-files-terminal-artifact-fixtures'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES } from './files/file-preview-budget'
import type { RuntimeFileCommands } from './orca-runtime-files'

vi.mock('fs', async () => (await import('./orca-runtime-files-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./orca-runtime-files-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './file-watcher-host',
  async () => (await import('./orca-runtime-files-mock-registry')).fileWatcherHostMock
)
vi.mock('../ipc/filesystem/filesystem-auth', async () =>
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

    function resolveRemoteNativeChatArtifact(commands: RuntimeFileCommands, artifactPath: string) {
      return commands.resolveTerminalPath('id:wt-1', artifactPath, null, 'client-a', null, true, {
        tabId: 'tab-1',
        sessionId: 'session-1'
      })
    }

    it('reads an absolute terminal artifact only for the client that received the grant', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => false, size: 11, dev: 1, ino: 2, mtimeMs: 3 })

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
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

    it('revokes absolute terminal artifact grants when the owning client disconnects', async () => {
      const artifactPath = await tempFile('result.json', '{}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => false, size: 2, dev: 1, ino: 2, mtimeMs: 3 })

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)

      commands.revokeTerminalFileGrantsForClient('client-a')

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_expired')
    })

    it('expires absolute terminal artifact grants without waiting for another tap', async () => {
      const artifactPath = await tempFile('result.json', '{}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => false, size: 2, dev: 1, ino: 2, mtimeMs: 3 })

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1)

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_expired')
      expect(statMock).not.toHaveBeenCalled()
    })

    it('rejects stale absolute terminal artifact writes before changing the file', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
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

    it('keeps the original terminal artifact when atomic commit fails', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      renameMock.mockRejectedValueOnce(new Error('ENOSPC'))

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
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

    it('rejects hard-linked terminal artifact writes after a grant is created', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const hardLinkPath = join(artifactPath, '..', 'linked-result.json')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)
      await link(artifactPath, hardLinkPath)

      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          '{"ok":false}',
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe('{"ok":true}')
    })

    it('rejects stale absolute terminal artifact reads before returning changed content', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)

      await rm(artifactPath)
      await writeFile(artifactPath, '{"ok":false}')

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
    })

    it('rejects retargeted symlink terminal artifact reads before returning outside content', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const outsidePath = join(artifactPath, '..', 'outside.json')
      await writeFile(outsidePath, '{"secret":true}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
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
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
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

    it('does not renew stale terminal artifact grants', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)
      await rm(artifactPath)
      await writeFile(artifactPath, '{"ok":false}')

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1)

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_expired')
    })

    it('rejects stale absolute terminal artifact previews before returning changed content', async () => {
      const artifactPath = await tempFile('result.png', 'fake-png')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)

      await rm(artifactPath)
      await writeFile(artifactPath, 'changed!')

      await expect(
        commands.readTerminalArtifactPreview(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
    })

    it('keeps local terminal artifact previews above the remote cap available', async () => {
      const size = RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES + 1
      const artifactPath = await tempFile('result.png', 'a'.repeat(size))
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)

      await expect(
        commands.readTerminalArtifactPreview(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).resolves.toMatchObject({
        content: Buffer.alloc(size, 0x61).toString('base64'),
        isBinary: true,
        isImage: true,
        mimeType: 'image/png'
      })
    })

    it('rejects binary-extension terminal artifacts from the editable text path', async () => {
      const artifactPath = await tempFile('report.pdf', '%PDF text-looking bytes')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({
        isDirectory: () => false,
        size: 23,
        dev: 1,
        ino: 2,
        mtimeMs: 3
      })

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
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

    it('refuses a native-chat artifact on an SSH target as not served', async () => {
      const { commands, store } = createRuntimeFileCommands({
        path: '/repo',
        hasRecentNativeChatOutputPath: vi.fn(() => true)
      })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

      await expect(
        resolveRemoteNativeChatArtifact(commands, '/home/me/report.json')
      ).rejects.toThrow(SshHostNotServedError)
    })
  })
})
