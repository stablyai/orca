import { constants } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAuthorizedPathMock } from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'

const mutations = vi.hoisted(() => ({ copyFile: vi.fn(), mkdir: vi.fn(), rm: vi.fn() }))

vi.mock('node:fs/promises', async () => ({
  ...(await vi.importActual<typeof FsPromises>('node:fs/promises')),
  ...mutations
}))
vi.mock('../ipc/filesystem-auth', async () =>
  (await import('./orca-runtime-files-mock-registry')).filesystemAuthModuleMock()
)

function commitUpload(): Promise<{ ok: true; tempRemoved: true }> {
  return createRuntimeFileCommands().commands.commitFileExplorerUpload(
    'id:wt-1',
    'assets/.note.txt.orca-upload-a',
    'assets/note.txt',
    undefined,
    undefined,
    'local'
  )
}

describe('runtime upload commit cleanup receipt', () => {
  useRuntimeFileCommandsLifecycle()

  beforeEach(() => {
    mutations.copyFile.mockReset().mockResolvedValue(undefined)
    mutations.mkdir.mockReset().mockResolvedValue(undefined)
    mutations.rm.mockReset().mockResolvedValue(undefined)
    resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
  })

  it('confirms removal only after the temporary file has been removed', async () => {
    const removal = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    mutations.rm.mockImplementation(() => {
      started.resolve()
      return removal.promise
    })
    const settled = vi.fn()
    const commit = commitUpload().then((result) => {
      settled()
      return result
    })

    await started.promise
    expect(settled).not.toHaveBeenCalled()
    expect(mutations.copyFile).toHaveBeenCalledWith(
      '/repo/assets/.note.txt.orca-upload-a',
      '/repo/assets/note.txt',
      constants.COPYFILE_EXCL
    )
    expect(mutations.rm).toHaveBeenCalledWith('/repo/assets/.note.txt.orca-upload-a', {
      force: true
    })
    removal.resolve()
    await expect(commit).resolves.toEqual({ ok: true, tempRemoved: true })
  })

  it('does not confirm cleanup when removal fails', async () => {
    mutations.rm.mockRejectedValue(new Error('cleanup denied'))

    await expect(commitUpload()).rejects.toThrow('cleanup denied')
  })

  it('keeps the staged file when exclusive copy refuses a destination collision', async () => {
    mutations.copyFile.mockRejectedValue(new Error('EEXIST'))

    await expect(commitUpload()).rejects.toThrow('EEXIST')
    expect(mutations.rm).not.toHaveBeenCalled()
  })
})
