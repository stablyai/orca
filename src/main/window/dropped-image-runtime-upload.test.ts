import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_IMAGE_TOO_LARGE_ERROR } from '../../shared/clipboard-image'

const { saveClipboardImageBufferInRuntimeMock } = vi.hoisted(() => ({
  saveClipboardImageBufferInRuntimeMock: vi.fn(async () => '/remote/temp/orca-paste-1.png')
}))

vi.mock('./clipboard-runtime-image-upload', () => ({
  saveClipboardImageBufferInRuntime: saveClipboardImageBufferInRuntimeMock
}))

import { saveDroppedImageFileInRuntime } from './dropped-image-runtime-upload'

describe('saveDroppedImageFileInRuntime', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true })
    }
    vi.clearAllMocks()
  })

  async function fileWith(name: string, bytes: Buffer): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dropped-image-'))
    dirs.push(dir)
    const path = join(dir, name)
    await writeFile(path, bytes)
    return path
  }

  it('uploads image bytes to the runtime temp dir and returns the remote path', async () => {
    const path = await fileWith('shot.png', Buffer.from([1, 2, 3]))
    const remote = await saveDroppedImageFileInRuntime('/user-data', 'env-1', path)
    expect(remote).toBe('/remote/temp/orca-paste-1.png')
    expect(saveClipboardImageBufferInRuntimeMock).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      Buffer.from([1, 2, 3]),
      null
    )
  })

  it('refuses non-image files before reading them', async () => {
    const path = await fileWith('notes.txt', Buffer.from([1, 2, 3]))
    await expect(saveDroppedImageFileInRuntime('/user-data', 'env-1', path)).rejects.toThrow(
      'Only image files can be attached to a remote session'
    )
    expect(saveClipboardImageBufferInRuntimeMock).not.toHaveBeenCalled()
  })

  it('refuses oversized images', async () => {
    const path = await fileWith('huge.png', Buffer.alloc(20 * 1024 * 1024))
    await expect(saveDroppedImageFileInRuntime('/user-data', 'env-1', path)).rejects.toThrow(
      CLIPBOARD_IMAGE_TOO_LARGE_ERROR
    )
    expect(saveClipboardImageBufferInRuntimeMock).not.toHaveBeenCalled()
  })

  it('throws a readable error for a missing file', async () => {
    await expect(
      saveDroppedImageFileInRuntime('/user-data', 'env-1', join(tmpdir(), 'nope.png'))
    ).rejects.toThrow()
    expect(saveClipboardImageBufferInRuntimeMock).not.toHaveBeenCalled()
  })
})
