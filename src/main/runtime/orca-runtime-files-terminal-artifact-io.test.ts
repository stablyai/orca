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
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES } from './orca-runtime-files'
import type { RuntimeFileCommands } from './orca-runtime-files'

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

describe('RuntimeFileCommands', () => {
  useRuntimeFileCommandsLifecycle()

  describe('resolveTerminalPath', () => {
    const { tempFile } = useTerminalArtifactTempFiles()

    function createRemoteTerminalArtifactGrantFixture(
      artifactPath = '/tmp/result.json',
      nativeChat = false
    ) {
      const { commands, store } = createRuntimeFileCommands({
        path: '/repo',
        ...(nativeChat ? { hasRecentNativeChatOutputPath: vi.fn(() => true) } : {})
      })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      let realArtifactPath = artifactPath
      let artifactStat = { type: 'file', size: 11, mtime: 3 }
      const stat = vi.fn(async () => artifactStat)
      const readTerminalArtifact = vi
        .fn()
        .mockResolvedValue({ content: '{"ok":true}', isBinary: false })
      const writeTerminalArtifact = vi.fn().mockResolvedValue({ type: 'file', size: 12, mtime: 4 })
      const realpath = vi.fn(async (p: string) => (p === artifactPath ? realArtifactPath : p))
      vi.mocked(getSshFilesystemProvider).mockReturnValue({
        stat,
        readTerminalArtifact,
        realpath,
        writeTerminalArtifact
      } as never)
      return {
        commands,
        readTerminalArtifact,
        writeTerminalArtifact,
        moveArtifactTarget: (nextPath: string) => {
          realArtifactPath = nextPath
        },
        replaceArtifact: () => {
          artifactStat = { type: 'file', size: 12, mtime: 4 }
        }
      }
    }

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

    it('rejects remote binary terminal artifact writes before changing the file', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const stat = vi
        .fn()
        .mockResolvedValue({ type: 'file', size: 4, mtimeMs: 3, isDirectory: () => false })
      const writeTerminalArtifact = vi.fn().mockRejectedValue(new Error('binary_file'))
      const realpath = vi.fn(async (p: string) => p)
      const writeFile = vi.fn()
      vi.mocked(getSshFilesystemProvider).mockReturnValue({
        stat,
        realpath,
        writeFile,
        writeTerminalArtifact
      } as never)

      const result = await resolveTerminalArtifactPath(commands, '/tmp/result.txt')
      const grantId = result.openTarget?.kind === 'absolute-file' ? result.openTarget.grantId : ''

      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          grantId,
          '/tmp/result.txt',
          'not binary anymore',
          'client-a'
        )
      ).rejects.toThrow('binary_file')
      expect(writeFile).not.toHaveBeenCalled()
      expect(writeTerminalArtifact).toHaveBeenCalled()
    })

    it('reads a remote non-temp artifact cited by native chat', async () => {
      const artifactPath = '/home/me/report.json'
      const { commands, readTerminalArtifact } = createRemoteTerminalArtifactGrantFixture(
        artifactPath,
        true
      )
      const result = await resolveRemoteNativeChatArtifact(commands, artifactPath)
      const target = absoluteFileTarget(result)

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).resolves.toMatchObject({ content: '{"ok":true}' })
      expect(readTerminalArtifact).toHaveBeenCalledWith(
        artifactPath,
        expect.objectContaining({ expectedRealPath: artifactPath })
      )
    })

    it('rejects a retargeted remote native-chat artifact grant', async () => {
      const artifactPath = '/home/me/report.json'
      const { commands, readTerminalArtifact, moveArtifactTarget } =
        createRemoteTerminalArtifactGrantFixture(artifactPath, true)
      const result = await resolveRemoteNativeChatArtifact(commands, artifactPath)
      const target = absoluteFileTarget(result)

      moveArtifactTarget('/home/me/private.json')

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
      expect(readTerminalArtifact).not.toHaveBeenCalled()
    })

    it('rejects a replaced remote native-chat artifact grant', async () => {
      const artifactPath = '/home/me/report.json'
      const { commands, readTerminalArtifact, replaceArtifact } =
        createRemoteTerminalArtifactGrantFixture(artifactPath, true)
      const result = await resolveRemoteNativeChatArtifact(commands, artifactPath)
      const target = absoluteFileTarget(result)

      replaceArtifact()

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
      expect(readTerminalArtifact).not.toHaveBeenCalled()
    })

    it('rejects remote terminal artifact reads when a grant no longer resolves to the granted path', async () => {
      const { commands, readTerminalArtifact, moveArtifactTarget } =
        createRemoteTerminalArtifactGrantFixture()
      const result = await resolveTerminalArtifactPath(commands, '/tmp/result.json')
      const target = absoluteFileTarget(result)

      moveArtifactTarget('/home/me/.ssh/config')

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
      expect(readTerminalArtifact).not.toHaveBeenCalled()
    })

    it('rejects remote terminal artifact previews when a grant no longer resolves to the granted path', async () => {
      const { commands, readTerminalArtifact, moveArtifactTarget } =
        createRemoteTerminalArtifactGrantFixture('/tmp/result.png')
      const result = await resolveTerminalArtifactPath(commands, '/tmp/result.png')
      const target = absoluteFileTarget(result)

      moveArtifactTarget('/tmp/other.png')

      await expect(
        commands.readTerminalArtifactPreview(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
      expect(readTerminalArtifact).not.toHaveBeenCalled()
    })

    it('rejects additive remote terminal preview fields beyond the request budget', async () => {
      const { commands, readTerminalArtifact } =
        createRemoteTerminalArtifactGrantFixture('/tmp/result.png')
      const result = await resolveTerminalArtifactPath(commands, '/tmp/result.png')
      const target = absoluteFileTarget(result)
      readTerminalArtifact.mockResolvedValue({
        content: 'a',
        isBinary: true,
        futureMetadata: 'x'.repeat(128)
      })

      await expect(
        commands.readTerminalArtifactPreview(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a',
          128
        )
      ).rejects.toThrow('file_too_large')
    })

    it('rejects remote terminal artifact writes when a grant no longer resolves to the granted path', async () => {
      const { commands, readTerminalArtifact, writeTerminalArtifact, moveArtifactTarget } =
        createRemoteTerminalArtifactGrantFixture()
      const result = await resolveTerminalArtifactPath(commands, '/tmp/result.json')
      const target = absoluteFileTarget(result)

      moveArtifactTarget('/home/me/.ssh/config')

      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          '{"ok":false}',
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
      expect(readTerminalArtifact).not.toHaveBeenCalled()
      expect(writeTerminalArtifact).not.toHaveBeenCalled()
    })
  })
})
