import { RuntimeFileAccess } from './file-access'
import { describe, expect, it, vi } from 'vitest'

import type * as FileSystem from 'node:fs/promises'
import { resolveAuthorizedPathMock, statMock } from './runtime-file-command-mock-registry'
import {
  createRuntimeFileHost,
  useRuntimeFileHostLifecycle
} from './runtime-file-host.test-fixture'

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

describe('RuntimeFileAccess', () => {
  useRuntimeFileHostLifecycle()

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
      const { commands } = createFileAccess()
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

function createFileAccess(options?: Parameters<typeof createRuntimeFileHost>[0]) {
  const { host, store } = createRuntimeFileHost(options)
  return { commands: new RuntimeFileAccess(host), store }
}
