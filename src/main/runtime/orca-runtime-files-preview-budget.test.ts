import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAuthorizedPathMock, statMock } from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import { RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES } from './files/file-preview-budget'
import { REMOTE_RPC_MAX_CONTENT_BYTES } from '../../shared/remote-rpc-content-budget'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

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

  // Mobile image tabs use readPreview; exceeding the outbound budget would kill their socket.
  describe('previewable binary budget', () => {
    const previewTempDirs: string[] = []
    const pngImage = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64'
    )

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

    it('rejects a previewable image one byte above the cap', async () => {
      const dir = await previewFixture(RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES + 1)
      const { commands } = createRuntimeFileCommands({ path: dir })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      await expect(
        commands.readFileExplorerPreview('id:wt-1', 'logo.png', REMOTE_RPC_MAX_CONTENT_BYTES)
      ).rejects.toThrow('file_too_large')
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

    // Phones read images a chat names by host path; only image files on this machine qualify.
    it('reads a chat image outside every project root but never another file type', async () => {
      const dir = await previewFixture()
      await writeFile(join(dir, 'notes.txt'), 'secret')
      const { commands } = createRuntimeFileCommands()
      statMock.mockResolvedValue({ isFile: () => true })
      resolveAuthorizedPathMock.mockRejectedValue(new Error('Access denied'))

      await expect(
        commands.readChatImagePreview(
          'id:wt-1',
          join(dir, 'logo.png'),
          REMOTE_RPC_MAX_CONTENT_BYTES
        )
      ).resolves.toEqual({
        content: Buffer.from('aaaaaaaa').toString('base64'),
        isBinary: true,
        isImage: true,
        mimeType: 'image/png'
      })
      await expect(
        commands.readChatImagePreview('id:wt-1', join(dir, 'notes.txt'))
      ).rejects.toThrow('only show local image files')
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      await expect(
        commands.readChatImagePreview('id:wt-1', join(dir, 'notes.txt'))
      ).rejects.toThrow('not_an_image')
    })

    it('serves extensionless chat images with their detected MIME type and enforces the budget', async () => {
      const dir = await previewFixture()
      const filePath = join(dir, 'downloaded-image')
      await writeFile(filePath, pngImage)
      const { commands } = createRuntimeFileCommands()
      statMock.mockResolvedValue({ isFile: () => true })
      resolveAuthorizedPathMock.mockRejectedValue(new Error('Access denied'))

      await expect(commands.readChatImagePreview('id:wt-1', filePath)).resolves.toEqual({
        content: pngImage.toString('base64'),
        isBinary: true,
        isImage: true,
        mimeType: 'image/png'
      })
      await expect(commands.readChatImagePreview('id:wt-1', filePath, 1)).rejects.toThrow(
        'file_too_large'
      )
    })

    it.each(['image.pdf', 'image.mp4', 'image.txt'])(
      'does not override the non-image extension of an in-project %s',
      async (name) => {
        const dir = await previewFixture()
        const filePath = join(dir, name)
        await writeFile(filePath, pngImage)
        const { commands } = createRuntimeFileCommands({ path: dir })
        resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

        await expect(commands.readChatImagePreview('id:wt-1', filePath)).rejects.toThrow(
          'not_an_image'
        )
      }
    )

    it('refuses chat images for an SSH workspace, whose paths name the remote machine', async () => {
      const dir = await previewFixture()
      const { commands } = createRuntimeFileCommands({
        resolveRuntimeFileTarget: vi.fn(async () => ({
          worktree: { id: 'wt-1', repoId: 'repo-1', path: '/remote/repo' },
          executionHostId: 'ssh:ssh-1'
        }))
      })

      await expect(commands.readChatImagePreview('id:wt-1', join(dir, 'logo.png'))).rejects.toThrow(
        SshHostNotServedError
      )
    })
  })
})
