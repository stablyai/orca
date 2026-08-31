import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAuthorizedPathMock } from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES } from './orca-runtime-files'
import { REMOTE_RPC_MAX_CONTENT_BYTES } from '../../shared/remote-rpc-content-budget'
import { FileReadCapExceededError, StreamProtocolError } from '../ssh/ssh-filesystem-stream-reader'

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

  // Why: mobile opens every image tab through files.readPreview, so this constant is the most
  // reachable way to overflow the outbound envelope and kill the socket.
  describe('previewable binary budget', () => {
    const previewTempDirs: string[] = []

    afterEach(async () => {
      await Promise.all(previewTempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
      previewTempDirs.length = 0
    })

    async function previewFixture(size = Buffer.byteLength('fake-png')): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'orca-preview-budget-'))
      previewTempDirs.push(dir)
      await writeFile(join(dir, 'logo.png'), Buffer.alloc(size, 0x61))
      return dir
    }

    it('stays inside the transport ceiling once base64-inflated', () => {
      const result = {
        content: Buffer.alloc(RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES).toString('base64'),
        isBinary: true,
        isImage: true,
        mimeType: 'image/png'
      }

      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
        REMOTE_RPC_MAX_CONTENT_BYTES
      )
    })

    it('rejects a previewable image one byte above the cap', async () => {
      const dir = await previewFixture(RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES + 1)
      const { commands } = createRuntimeFileCommands({ path: dir })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      await expect(
        commands.readFileExplorerPreview('id:wt-1', 'logo.png', REMOTE_RPC_MAX_CONTENT_BYTES)
      ).rejects.toThrow('file_too_large')
    })

    it('returns full base64 for a previewable image at the cap', async () => {
      const dir = await previewFixture(RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES)
      const { commands } = createRuntimeFileCommands({ path: dir })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      await expect(
        commands.readFileExplorerPreview('id:wt-1', 'logo.png', REMOTE_RPC_MAX_CONTENT_BYTES)
      ).resolves.toEqual({
        content: Buffer.alloc(RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES, 0x61).toString('base64'),
        isBinary: true,
        isImage: true,
        mimeType: 'image/png'
      })
    })

    it('keeps local previews above the remote cap available without a request budget', async () => {
      const size = RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES + 1
      const dir = await previewFixture(size)
      const { commands } = createRuntimeFileCommands({ path: dir })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      await expect(commands.readFileExplorerPreview('id:wt-1', 'logo.png')).resolves.toEqual({
        content: Buffer.alloc(size, 0x61).toString('base64'),
        isBinary: true,
        isImage: true,
        mimeType: 'image/png'
      })
    })

    it('rejects an SSH text preview past the decoded text limit the local branch enforces', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      // NUL-free control bytes: sniffed as text, yet each escapes to six JSON bytes.
      const content = '\u0001'.repeat(1024 * 1024)
      vi.mocked(getSshFilesystemProvider).mockReturnValue({
        stat: vi.fn().mockResolvedValue({ type: 'file', size: content.length }),
        readFile: vi.fn().mockResolvedValue({ content, isBinary: false })
      } as never)

      await expect(commands.readFileExplorerPreview('id:wt-1', 'log.txt')).rejects.toThrow(
        'file_too_large'
      )
    })

    it('still returns an SSH binary preview inside the base64 cap', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const preview = { content: 'a'.repeat(1024 * 1024), isBinary: true, isImage: true }
      vi.mocked(getSshFilesystemProvider).mockReturnValue({
        stat: vi
          .fn()
          .mockResolvedValue({ type: 'file', size: RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES }),
        readFile: vi.fn().mockResolvedValue(preview)
      } as never)

      await expect(commands.readFileExplorerPreview('id:wt-1', 'logo.png')).resolves.toEqual(
        preview
      )
    })

    it('rejects an SSH binary result that grew past its request-scoped budget', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const readFile = vi.fn().mockResolvedValue({
        content: 'a'.repeat(13),
        isBinary: true,
        isImage: true
      })
      vi.mocked(getSshFilesystemProvider).mockReturnValue({
        stat: vi.fn().mockResolvedValue({ type: 'file', size: 0 }),
        readFile
      } as never)

      await expect(commands.readFileExplorerPreview('id:wt-1', 'logo.png', 12)).rejects.toThrow(
        'file_too_large'
      )
      expect(readFile).toHaveBeenCalledWith('/repo/logo.png', {
        maxBinaryBytes: 0,
        maxTextBytes: 512 * 1024
      })
    })

    it('rejects escape-dense SSH text beyond the request-scoped result budget', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      vi.mocked(getSshFilesystemProvider).mockReturnValue({
        stat: vi.fn().mockResolvedValue({ type: 'file', size: 64 }),
        readFile: vi.fn().mockResolvedValue({ content: '\u0001'.repeat(64), isBinary: false })
      } as never)

      await expect(commands.readFileExplorerPreview('id:wt-1', 'log.txt', 128)).rejects.toThrow(
        'file_too_large'
      )
    })

    // Why: without translation the reader's raw "exceeds client cap" string reaches the client as a
    // generic runtime_error, which neither the desktop nor the mobile preview arm recognizes.
    it('translates an over-cap stream read into file_too_large', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      vi.mocked(getSshFilesystemProvider).mockReturnValue({
        stat: vi.fn().mockResolvedValue({ type: 'file', size: 1024 }),
        readFile: vi
          .fn()
          .mockRejectedValue(
            new FileReadCapExceededError('Reported totalSize 900000 exceeds client cap 524288')
          )
      } as never)

      await expect(commands.readFileExplorerPreview('id:wt-1', 'log.txt')).rejects.toThrow(
        'file_too_large'
      )
    })

    it('leaves a genuine stream protocol failure unmasked', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      vi.mocked(getSshFilesystemProvider).mockReturnValue({
        stat: vi.fn().mockResolvedValue({ type: 'file', size: 1024 }),
        readFile: vi.fn().mockRejectedValue(new StreamProtocolError('Malformed chunk for stream 4'))
      } as never)

      await expect(commands.readFileExplorerPreview('id:wt-1', 'log.txt')).rejects.toThrow(
        'Malformed chunk'
      )
    })

    it('rejects oversized SSH preview metadata with small content', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      vi.mocked(getSshFilesystemProvider).mockReturnValue({
        stat: vi.fn().mockResolvedValue({ type: 'file', size: 1 }),
        readFile: vi.fn().mockResolvedValue({
          content: 'a',
          isBinary: true,
          mimeType: 'x'.repeat(128)
        })
      } as never)

      await expect(commands.readFileExplorerPreview('id:wt-1', 'logo.png', 128)).rejects.toThrow(
        'file_too_large'
      )
    })

    it('sends preview authority to the SSH execution host in one read', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const readDocPreviewFile = vi.fn().mockResolvedValue({ content: 'ok', isBinary: false })
      vi.mocked(getSshFilesystemProvider).mockReturnValue({ readDocPreviewFile } as never)

      await expect(
        commands.readDocPreviewFile('id:wt-1', 'docs/index.html', 'docs/index.html', 'docs', [
          'assets'
        ])
      ).resolves.toEqual({ content: 'ok', isBinary: false })
      expect(readDocPreviewFile).toHaveBeenCalledWith({
        boundaryPath: '/repo',
        entryPath: '/repo/docs/index.html',
        implicitRootPath: '/repo/docs',
        authorizedRootPaths: ['/repo/assets'],
        targetPath: '/repo/docs/index.html',
        maxTextBytes: 512 * 1024,
        maxBinaryBytes: 10 * 1024 * 1024
      })
    })

    it('fails closed when the SSH execution host lacks scoped preview reads', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      vi.mocked(getSshFilesystemProvider).mockReturnValue({} as never)

      await expect(
        commands.readDocPreviewFile('id:wt-1', 'docs/index.html', 'docs/index.html', 'docs', [])
      ).rejects.toThrow('newer SSH relay')
    })
  })
})
