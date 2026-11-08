import { RuntimeFileReads } from './file-reads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAuthorizedPathMock, statMock } from './runtime-file-command-mock-registry'
import {
  createRuntimeFileHost,
  useRuntimeFileHostLifecycle
} from './runtime-file-host.test-fixture'
import { RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES } from './file-preview-budget'
import { REMOTE_RPC_MAX_CONTENT_BYTES } from '../../../shared/remote-rpc-content-budget'

vi.mock('fs', async () => (await import('./runtime-file-command-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./runtime-file-command-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './watch/file-watcher-host',
  async () => (await import('./runtime-file-command-mock-registry')).fileWatcherHostMock
)
vi.mock('../../ipc/filesystem/access/filesystem-auth', async () =>
  (await import('./runtime-file-command-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../../git/runner', async () =>
  (await import('./runtime-file-command-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../../ipc/local-worktree-runtime-options',
  async () => (await import('./runtime-file-command-mock-registry')).localWorktreeRuntimeOptionsMock
)

describe('RuntimeFileReads', () => {
  useRuntimeFileHostLifecycle()

  // Mobile image tabs use readPreview; exceeding the outbound budget would kill their socket.
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

    it('rejects a previewable image one byte above the cap', async () => {
      const dir = await previewFixture(RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES + 1)
      const { commands } = createFileReads({ path: dir })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      await expect(
        commands.readFileExplorerPreview('id:wt-1', 'logo.png', REMOTE_RPC_MAX_CONTENT_BYTES)
      ).rejects.toThrow('file_too_large')
    })

    it('keeps local previews above the remote cap available without a request budget', async () => {
      const size = RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES + 1
      const dir = await previewFixture(size)
      const { commands } = createFileReads({ path: dir })
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
      const { commands } = createFileReads()
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
  })
})

function createFileReads(options?: Parameters<typeof createRuntimeFileHost>[0]) {
  const { host, store } = createRuntimeFileHost(options)
  return { commands: new RuntimeFileReads(host), store }
}
