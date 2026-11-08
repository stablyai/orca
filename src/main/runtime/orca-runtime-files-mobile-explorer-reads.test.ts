import { describe, expect, it, vi } from 'vitest'

import type * as FileSystem from 'node:fs/promises'
import { resolveAuthorizedPathMock, statMock } from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'

vi.mock('fs', async () => (await import('./orca-runtime-files-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./orca-runtime-files-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './file-watcher-host',
  async () => (await import('./orca-runtime-files-mock-registry')).fileWatcherHostMock
)
vi.mock('../ipc/filesystem/access/filesystem-auth', async () =>
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

  it('detects a real same-size rewrite even after restoring the modification time', async () => {
    vi.useRealTimers()
    const files = await vi.importActual<typeof FileSystem>('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const root = await files.mkdtemp(join(tmpdir(), 'orca-media-revision-'))
    const filePath = join(root, 'video.mp4')
    try {
      await files.writeFile(filePath, 'abc')
      await files.utimes(filePath, 1, 2)
      const { commands } = createRuntimeFileCommands()
      resolveAuthorizedPathMock.mockResolvedValue(filePath)
      statMock.mockImplementation((path: string) => files.stat(path))
      const before = await commands.statRuntimeFile('id:wt-1', 'video.mp4')
      await new Promise((resolve) => setTimeout(resolve, 20))
      await files.writeFile(filePath, 'xyz')
      await files.utimes(filePath, 1, 2)
      const after = await commands.statRuntimeFile('id:wt-1', 'video.mp4')
      expect(after.size).toBe(before.size)
      expect(after.mtime).toBe(before.mtime)
      expect(after.ctime).not.toBe(before.ctime)
    } finally {
      await files.rm(root, { recursive: true, force: true })
    }
  })
})
