import { describe, expect, it, vi } from 'vitest'
import { link, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
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
vi.mock('../ipc/filesystem-auth', async () =>
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

    it('keeps old-client behavior without a native-chat context', async () => {
      const artifactPath = await tempFile('result.json', '{}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })

      const result = await commands.resolveTerminalPath('id:wt-1', artifactPath, null, 'client-a')

      expect(result).toMatchObject({
        worktree: 'wt-1',
        relativePath: null,
        exists: false,
        isDirectory: false
      })
      expect(result.openTarget).toBeUndefined()
    })

    it('mints a read-only exact-path grant for any host file a chat links', async () => {
      const artifactPath = await tempFile('chat-result.html', '<h1>Result</h1>')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        artifactPath,
        null,
        'client-a',
        null,
        true,
        { tabId: 'tab-1', sessionId: 'session-1' }
      )

      expect(result).toMatchObject({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: await realpath(artifactPath),
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          provider: 'local',
          absolutePath: await realpath(artifactPath),
          readOnly: true
        }
      })
      const target = absoluteFileTarget(result)
      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          '<h1>Changed</h1>',
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_read_only')
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe('<h1>Result</h1>')
    })

    it('renews a chat grant for a phone that re-resolves without crossWorkspace', async () => {
      // Why: phones re-resolve expired previews with only the chat context (old and new builds).
      const artifactPath = await tempFile('chat-report.pdf', '%PDF-1.7')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        artifactPath,
        null,
        'client-a',
        null,
        undefined,
        { tabId: 'tab-1', sessionId: 'session-1' }
      )

      expect(result).toMatchObject({ exists: true, openTarget: { kind: 'absolute-file' } })
    })

    it('binds a linked symlink alias to its canonical read-only target', async () => {
      const artifactPath = await tempFile('chat-target.html', '<h1>Result</h1>')
      const citedPath = join(artifactPath, '..', 'chat-citation.html')
      await symlink(artifactPath, citedPath)
      const { commands } = createRuntimeFileCommands({ path: '/repo' })

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        citedPath,
        null,
        'client-a',
        null,
        true,
        { tabId: 'tab-1', sessionId: 'session-1' }
      )

      expect(result).toMatchObject({
        absolutePath: await realpath(artifactPath),
        exists: true,
        openTarget: {
          kind: 'absolute-file',
          absolutePath: await realpath(artifactPath),
          readOnly: true
        }
      })
    })

    it.skipIf(process.platform === 'win32')(
      'refuses a named pipe a chat links instead of waiting on it',
      async () => {
        const dir = await mkdtemp(join(tmpdir(), 'orca-chat-pipe-'))
        tempDirs.push(dir)
        const pipePath = join(dir, 'report.png')
        execFileSync('mkfifo', [pipePath])
        const { commands } = createRuntimeFileCommands({ path: '/repo' })

        const result = await commands.resolveTerminalPath(
          'id:wt-1',
          pipePath,
          null,
          'client-a',
          null,
          true,
          { tabId: 'tab-1', sessionId: 'session-1' }
        )

        expect(result).toMatchObject({ relativePath: null, exists: false })
        expect(result.openTarget).toBeUndefined()
      }
    )

    it('refuses native-chat tilde paths when the workspace runs in WSL', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const { commands } = createRuntimeFileCommands({
        path: String.raw`\\wsl.localhost\Ubuntu\work\repo`
      })

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        '~/.ssh/config',
        null,
        'client-a',
        null,
        true,
        { tabId: 'tab-1', sessionId: 'session-1' }
      )

      expect(result).toMatchObject({ relativePath: null, absolutePath: null, exists: false })
    })

    it('does not mint an absolute terminal artifact grant for an unobserved path', async () => {
      const artifactPath = await tempFile('result.json', '{}')
      const hasRecentTerminalOutputPath = vi.fn(
        (_terminalHandle: string, _pathText: string, _absolutePath: string) => false
      )
      const { commands } = createRuntimeFileCommands({
        path: '/repo',
        hasRecentTerminalOutputPath
      })

      const result = await resolveTerminalArtifactPath(commands, artifactPath)

      expect(result).toMatchObject({
        worktree: 'wt-1',
        relativePath: null,
        exists: false,
        isDirectory: false
      })
      expect(result.openTarget).toBeUndefined()
      expect(hasRecentTerminalOutputPath).toHaveBeenCalledTimes(1)
      const observed = hasRecentTerminalOutputPath.mock.calls[0]!
      expect(observed[0]).toBe('term-1')
      expect(observed[1]).toBe(artifactPath)
      expect(observed[2]).toContain('result.json')
      expect(observed[1]).toContain('result.json')
    })

    it('does not mint an absolute artifact grant from a relative path observed under stale cwd', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-terminal-artifact-'))
      tempDirs.push(dir)
      const artifactPath = join(dir, 'result.json')
      await writeFile(artifactPath, '{}')
      const hasRecentTerminalOutputPath = vi.fn(
        (_terminalHandle: string, pathText: string, _absolutePath: string) =>
          pathText === 'result.json'
      )
      const { commands } = createRuntimeFileCommands({
        path: '/repo',
        hasRecentTerminalOutputPath
      })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockRejectedValue(enoent())

      const result = await resolveTerminalArtifactPath(commands, 'result.json', dir)

      expect(result).toMatchObject({
        relativePath: 'result.json',
        absolutePath: '/repo/result.json',
        exists: false
      })
      expect(result.openTarget).toBeUndefined()
      expect(hasRecentTerminalOutputPath).not.toHaveBeenCalled()
    })

    it('does not mint an artifact grant from a terminal attached to a different worktree', async () => {
      const artifactPath = await tempFile('result.json', '{}')
      const { commands } = createRuntimeFileCommands({
        path: '/repo',
        resolveTerminalContext: vi.fn(() => ({ worktreeId: 'other-wt', connectionId: null }))
      })

      const result = await resolveTerminalArtifactPath(commands, artifactPath)

      expect(result).toMatchObject({
        worktree: 'wt-1',
        relativePath: null,
        exists: false,
        isDirectory: false
      })
      expect(result.openTarget).toBeUndefined()
    })

    it('does not mint a local artifact grant from an SSH terminal handle', async () => {
      const artifactPath = await tempFile('result.json', '{}')
      const { commands } = createRuntimeFileCommands({
        path: '/repo',
        resolveTerminalContext: vi.fn(() => ({ worktreeId: 'wt-1', connectionId: 'ssh-1' }))
      })

      const result = await resolveTerminalArtifactPath(commands, artifactPath)

      expect(result).toMatchObject({
        worktree: 'wt-1',
        relativePath: null,
        exists: false,
        isDirectory: false
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

    it('does not grant hard-linked local temp artifacts', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-terminal-artifact-'))
      tempDirs.push(dir)
      const originalPath = join(dir, 'outside.json')
      const artifactPath = join(dir, 'result.json')
      await writeFile(originalPath, '{"secret":true}')
      await link(originalPath, artifactPath)
      const { commands } = createRuntimeFileCommands({ path: '/repo' })

      const result = await resolveTerminalArtifactPath(commands, artifactPath)

      expect(result).toMatchObject({
        relativePath: null,
        absolutePath: artifactPath,
        exists: false
      })
      expect(result.openTarget).toBeUndefined()
    })

    it('does not grant arbitrary absolute local paths outside temp roots', async () => {
      const { commands } = createRuntimeFileCommands({ path: '/repo' })

      const result = await commands.resolveTerminalPath('id:wt-1', '/etc/passwd', null, 'client-a')

      expect(result).toEqual({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/etc/passwd',
        exists: false,
        isDirectory: false
      })
      expect(resolveAuthorizedPathMock).not.toHaveBeenCalled()
      expect(statMock).not.toHaveBeenCalled()
    })

    it('does not grant remote temp artifacts that resolve outside allowed temp roots', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        '/tmp/link-result.json',
        null,
        'client-a'
      )

      expect(result).toEqual({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/tmp/link-result.json',
        exists: false,
        isDirectory: false
      })
      expect(statMock).not.toHaveBeenCalled()
    })
  })
})
