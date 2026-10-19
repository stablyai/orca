import { describe, expect, it, vi } from 'vitest'
import { openMock, resolveAuthorizedPathMock } from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

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

describe('RuntimeFileCommands.readFileExplorerChunk', () => {
  useRuntimeFileCommandsLifecycle()

  it('serves a local worktree from the local file handle', async () => {
    const contents = Buffer.from(Array.from({ length: 2048 }, (_, index) => (index * 31) % 251))
    const { commands } = createRuntimeFileCommands()
    resolveAuthorizedPathMock.mockResolvedValue('/repo/local.bin')
    const close = vi.fn(async () => undefined)
    openMock.mockResolvedValue({
      stat: vi.fn(async () => ({ isFile: () => true, size: contents.byteLength })),
      read: vi.fn(
        async (buffer: Buffer, bufferOffset: number, length: number, position: number) => {
          const bytesRead = contents.copy(buffer, bufferOffset, position, position + length)
          return { bytesRead }
        }
      ),
      close
    })

    const chunk = await commands.readFileExplorerChunk('id:wt-1', 'local.bin', 0, 1024)

    expect(Buffer.from(chunk.contentBase64, 'base64')).toEqual(contents.subarray(0, 1024))
    expect(chunk.eof).toBe(false)
    expect(close).toHaveBeenCalled()
  })

  it('refuses an SSH worktree without opening a local file', async () => {
    const { commands } = createRuntimeFileCommands({
      path: '/remote/repo',
      resolveRuntimeFileTarget: vi.fn(async () => ({
        worktree: { id: 'wt-1', repoId: 'repo-1', path: '/remote/repo' },
        executionHostId: 'ssh:ssh-1'
      }))
    })

    await expect(commands.readFileExplorerChunk('id:wt-1', 'big.bin', 0, 1024)).rejects.toThrow(
      SshHostNotServedError
    )
    expect(openMock).not.toHaveBeenCalled()
  })
})
