import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enoent, resolveAuthorizedPathMock, statMock } from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import {
  absoluteFileTarget,
  resolveTerminalArtifactPath,
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
    const { tempDirs, tempFile } = useTerminalArtifactTempFiles()

    it('returns an absolute open target for an existing local temp path outside the worktree', async () => {
      const artifactPath = await tempFile('result.json', '{}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => false, size: 12, dev: 1, ino: 2, mtimeMs: 3 })
      const canonicalPath = await realpath(artifactPath)

      const result = await resolveTerminalArtifactPath(commands, artifactPath)

      expect(result).toMatchObject({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: canonicalPath,
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          provider: 'local',
          absolutePath: canonicalPath
        }
      })
      expect(result.openTarget?.kind === 'absolute-file' ? result.openTarget.grantId : '').toMatch(
        /\S/
      )
      expect(resolveAuthorizedPathMock).not.toHaveBeenCalledWith(canonicalPath, expect.anything())
      expect(statMock).not.toHaveBeenCalled()
    })

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

    it('reports a missing file outside every workspace as absent', async () => {
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      const missingPath = join(tmpdir(), `orca-missing-${process.pid}-${Date.now()}.md`)

      const result = await commands.resolveTerminalPath('id:wt-1', missingPath, null, 'client-a')

      expect(result).toMatchObject({ relativePath: null, exists: false })
      expect(result.openTarget).toBeUndefined()
    })

    // Why: this machine's home is the Windows user's, not the distro user's.
    it('refuses tilde paths when the workspace runs in WSL', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const { commands } = createRuntimeFileCommands({
        path: String.raw`\\wsl.localhost\Ubuntu\work\repo`
      })

      const result = await resolveTerminalArtifactPath(commands, '~/.bashrc')

      expect(result).toMatchObject({ relativePath: null, absolutePath: null, exists: false })
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

    it('resolves a relative path against the terminal cwd, not a stale client cwd', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-terminal-artifact-'))
      tempDirs.push(dir)
      await writeFile(join(dir, 'result.json'), '{}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockRejectedValue(enoent())

      const result = await resolveTerminalArtifactPath(commands, 'result.json', dir)

      expect(result).toMatchObject({
        relativePath: 'result.json',
        absolutePath: '/repo/result.json',
        exists: false
      })
      expect(result.openTarget).toBeUndefined()
    })

    it('uses the canonical local temp artifact path for the exact grant', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-terminal-artifact-'))
      tempDirs.push(dir)
      const artifactPath = join(dir, 'result.json')
      const linkPath = join(dir, 'link-result.json')
      await writeFile(artifactPath, '{}')
      await symlink(artifactPath, linkPath)
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => false, size: 2, dev: 1, ino: 2, mtimeMs: 3 })
      const canonicalPath = await realpath(artifactPath)

      const result = await resolveTerminalArtifactPath(commands, linkPath)

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
      expect(resolveAuthorizedPathMock).not.toHaveBeenCalledWith(canonicalPath, expect.anything())
      expect(resolveAuthorizedPathMock).not.toHaveBeenCalledWith(linkPath, expect.anything())
    })

    it('does not stat this machine for a path outside an SSH workspace', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

      await expect(
        commands.resolveTerminalPath('id:wt-1', '/tmp/link-result.json', null, 'client-a')
      ).rejects.toThrow('outside an SSH workspace')
      expect(statMock).not.toHaveBeenCalled()
    })
  })
})
