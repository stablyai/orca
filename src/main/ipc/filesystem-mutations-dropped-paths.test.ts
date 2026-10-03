import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, args: unknown) => Promise<unknown>>()
const { handleMock, importSshMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  importSshMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
  app: { getPath: () => '/user-data' }
}))
vi.mock('./filesystem-import-ssh', () => ({ importExternalPathsSsh: importSshMock }))
vi.mock('../ssh/ssh-connection-generation', () => ({ assertSshMutationExpectation: () => {} }))

import { registerFilesystemMutationHandlers } from './filesystem-mutations'

beforeEach(() => {
  handlers.clear()
  handleMock.mockImplementation((channel: string, handler: never) => {
    handlers.set(channel, handler)
  })
  registerFilesystemMutationHandlers(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the drop handler under test never reads the store; registration only needs a Store-shaped value.
    { getRepos: () => [], getSettings: () => ({ workspaceDir: '/workspace' }) } as never
  )
})

describe('fs:resolveDroppedPathsForAgent', () => {
  it('keeps the cancel mark on each failed source so a cancel is not reported as an error', async () => {
    importSshMock.mockResolvedValue({
      results: [
        { sourcePath: '/a.txt', status: 'failed', reason: 'Upload cancelled', cancelled: true },
        { sourcePath: '/a.txt', status: 'failed', reason: 'disk full' }
      ]
    })

    const result = await handlers.get('fs:resolveDroppedPathsForAgent')!(
      { sender: { id: 1 } },
      { paths: ['/a.txt', '/a.txt'], worktreePath: '/remote/repo', connectionId: 'ssh-1' }
    )

    expect(result).toEqual({
      resolvedPaths: [],
      skipped: [],
      failed: [
        { sourcePath: '/a.txt', reason: 'Upload cancelled', cancelled: true },
        { sourcePath: '/a.txt', reason: 'disk full' }
      ]
    })
  })
})
