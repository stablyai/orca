import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { describe, expect, it, vi } from 'vitest'
import { realpath } from 'node:fs/promises'
import { openMock, resolveAuthorizedPathMock, statMock } from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import {
  resolveTerminalArtifactPath,
  statAsFile,
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
    const { tempFile } = useTerminalArtifactTempFiles()

    it('translates WSL absolute in-worktree paths before checking containment', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const worktreePath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
      const expectedPath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\src\\index.ts'
      const { commands } = createRuntimeFileCommands({ path: worktreePath })
      statAsFile()

      const result = await commands.resolveTerminalPath('id:wt-1', '/home/me/repo/src/index.ts')

      expect(result).toMatchObject({
        relativePath: 'src/index.ts',
        absolutePath: expectedPath,
        exists: true,
        openTarget: {
          kind: 'worktree-file',
          provider: 'local',
          relativePath: 'src/index.ts',
          absolutePath: expectedPath
        }
      })
      expect(resolveAuthorizedPathMock.mock.calls[0]?.[0]).toBe(expectedPath)
    })

    it('does not translate UNC-style paths as WSL POSIX paths', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const worktreePath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
      const { commands } = createRuntimeFileCommands({ path: worktreePath })

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        '//remote-host/tmp/result.json',
        null,
        'client-a'
      )

      expect(result).toEqual({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '//remote-host/tmp/result.json',
        exists: false,
        isDirectory: false
      })
      expect(resolveAuthorizedPathMock).not.toHaveBeenCalled()
      expect(statMock).not.toHaveBeenCalled()
    })

    it('preserves UNC-style paths for local Windows terminal links', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const worktreePath = '\\\\server\\share\\repo'
      const expectedPath = '//server/share/repo/src/index.ts'
      const { commands } = createRuntimeFileCommands({ path: worktreePath })
      statAsFile()

      const result = await commands.resolveTerminalPath('id:wt-1', expectedPath)

      expect(result).toMatchObject({
        relativePath: 'src/index.ts',
        absolutePath: expectedPath,
        exists: true,
        openTarget: {
          kind: 'worktree-file',
          provider: 'local',
          relativePath: 'src/index.ts',
          absolutePath: expectedPath
        }
      })
    })

    it('preserves local Windows UNC file URI authority even when OSC7 reported the host', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const worktreePath = '\\\\server\\share\\repo'
      const expectedPath = '//server/share/repo/src/index.ts'
      const resolveTerminalFileUriHostname = vi.fn(() => 'server')
      const { commands } = createRuntimeFileCommands({
        path: worktreePath,
        resolveTerminalFileUriHostname
      })
      statAsFile()

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        expectedPath,
        null,
        'client-a',
        'term-1'
      )

      expect(resolveTerminalFileUriHostname).toHaveBeenCalledWith('term-1')
      expect(result).toMatchObject({
        relativePath: 'src/index.ts',
        absolutePath: expectedPath,
        exists: true,
        openTarget: {
          kind: 'worktree-file',
          provider: 'local',
          relativePath: 'src/index.ts',
          absolutePath: expectedPath
        }
      })
    })

    it('preserves host-qualified local POSIX terminal links from unverified OSC7 host metadata', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      const artifactPath = await tempFile('result.json', '{}')
      const resolveTerminalFileUriHostname = vi.fn(() => 'laptop.local')
      const { commands } = createRuntimeFileCommands({
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
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
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
      const hasRecentTerminalOutputPath = vi.fn(() => true)
      const { commands, store } = createRuntimeFileCommands({
        path: '/home/me/repo',
        resolveTerminalFileUriHostname,
        hasRecentTerminalOutputPath
      })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

      await expect(
        resolveTerminalArtifactPath(commands, '//remote-host/tmp/result.json')
      ).rejects.toThrow(SshHostNotServedError)
      await expect(
        commands.resolveTerminalPath(
          'id:wt-1',
          '//remote-host/C:/Users/me/repo/src/app.ts',
          null,
          'client-a',
          'term-1'
        )
      ).rejects.toThrow(SshHostNotServedError)
      expect(hasRecentTerminalOutputPath).not.toHaveBeenCalled()
    })

    it('rejects host-qualified remote POSIX terminal links without a verified host match', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/home/me/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        '//remote-host/tmp/result.json',
        null,
        'client-a'
      )

      expect(statMock).not.toHaveBeenCalled()
      expect(result).toEqual({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '//remote-host/tmp/result.json',
        exists: false,
        isDirectory: false
      })
    })

    it('translates WSL temp artifacts before granting the exact path', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const worktreePath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
      const artifactPath = '\\\\wsl.localhost\\Ubuntu\\tmp\\result.json'
      const { commands } = createRuntimeFileCommands({ path: worktreePath })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => false, size: 2, dev: 1, ino: 2, mtimeMs: 3 })
      openMock.mockResolvedValue({
        stat: vi.fn(async () => ({
          isDirectory: () => false,
          size: 2,
          dev: 1,
          ino: 2,
          mtimeMs: 3
        })),
        read: vi.fn(async (buffer: Buffer) => {
          const bytesRead = buffer.write('{}')
          return { bytesRead, buffer }
        }),
        close: vi.fn(async () => undefined)
      })

      const result = await resolveTerminalArtifactPath(commands, '/tmp/result.json')

      expect(result).toMatchObject({
        relativePath: null,
        absolutePath: artifactPath,
        exists: true,
        openTarget: {
          kind: 'absolute-file',
          provider: 'local',
          absolutePath: artifactPath
        }
      })
      expect(resolveAuthorizedPathMock).not.toHaveBeenCalledWith(artifactPath, expect.anything())
    })
  })
})
