import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler)
  },
  app: { getPath: () => '/user-data' }
}))
vi.mock('../runtime-upload-file-stream', () => ({ streamExternalFileToRuntime: streamMock }))
vi.mock('../runtime-upload-temp-sweep', () => ({ sweepAbandonedRuntimeUploadTempPath: vi.fn() }))
vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: (_userDataPath: string, selector: string) => ({ id: selector })
}))

import { registerFilesystemMutationHandlers } from './filesystem-mutations'

registerFilesystemMutationHandlers(
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the upload and cancel handlers under test never read the store.
  { getRepos: () => [], getSettings: () => ({ workspaceDir: '/workspace' }) } as never
)

function renderer(id: number): EventEmitter & { id: number; isDestroyed: () => boolean } {
  return Object.assign(new EventEmitter(), { id, isDestroyed: () => false })
}

it("does not let another renderer cancel this renderer's upload id", async () => {
  const owner = renderer(1)
  const other = renderer(2)
  streamMock.mockImplementation(async ({ cancelSignal }: { cancelSignal: AbortSignal }) => {
    await handlers.get('fs:cancelRuntimeUpload')!({ sender: other }, { uploadId: 'same-id' })
    expect(cancelSignal.aborted).toBe(false)

    await handlers.get('fs:cancelRuntimeUpload')!({ sender: owner }, { uploadId: 'same-id' })
    expect(cancelSignal.aborted).toBe(true)
    await handlers.get('fs:releaseRuntimeUpload')!({ sender: owner }, { uploadId: 'same-id' })
    return { byteLength: 0 }
  })

  await expect(
    handlers.get('fs:uploadExternalFileToRuntime')!(
      { sender: owner },
      {
        environmentId: 'env-1',
        sourceRootPath: '/drop/file.bin',
        entryRelativePath: '',
        expected: { byteLength: 1, inode: 1, deviceId: 1, modifiedAtMs: 1 },
        worktree: 'wt-1',
        relativePath: '.file.bin.orca-upload-x',
        uploadId: 'same-id'
      }
    )
  ).resolves.toEqual({ byteLength: 0 })
})
