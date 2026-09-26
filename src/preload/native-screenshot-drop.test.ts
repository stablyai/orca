import { describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../shared/clipboard-image'
import { preserveNativeScreenshotDrop } from './native-screenshot-drop'

const source =
  '/var/folders/ab/user/T/TemporaryItems/NSIRD_screencaptureui_123/Screenshot 2026-09-08 at 6.55.16 PM.png'

function droppedFile(size = 3) {
  return { size, arrayBuffer: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer) }
}

describe('native screenshot drops', () => {
  it.each([source, `/private${source}`])('stages File bytes before relaying %s', async (path) => {
    const file = droppedFile()
    const save = vi.fn(async () => '/tmp/orca-paste-screenshot.png')
    const payload = {
      target: 'terminal' as const,
      paths: ['/workspace/readme.md', path],
      tabId: 'original-tab',
      paneLeafId: 'original-pane'
    }
    const result = await preserveNativeScreenshotDrop(
      payload,
      new Map([[path, file]]),
      'darwin',
      save
    )
    expect(save).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]))
    expect(result).toEqual({
      ...payload,
      paths: ['/workspace/readme.md', '/tmp/orca-paste-screenshot.png']
    })
    expect(payload.paths[1]).toBe(path)
  })

  it('preserves composer scope and drop order while saving asynchronously', async () => {
    const file = droppedFile()
    let complete!: (value: string) => void
    const save = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve
        })
    )
    const pending = preserveNativeScreenshotDrop(
      { target: 'composer', paths: [source, '/tmp/other.png'], scopeKey: 'original-composer' },
      new Map([[source, file]]),
      'darwin',
      save
    )
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    complete('/tmp/preserved.png')
    expect(await pending).toEqual({
      target: 'composer',
      paths: ['/tmp/preserved.png', '/tmp/other.png'],
      scopeKey: 'original-composer'
    })
  })

  it.each(['linux', 'win32'])('does not read dropped files on %s', async (platform) => {
    const file = droppedFile()
    const save = vi.fn()
    const payload = { target: 'terminal' as const, paths: [source] }
    expect(
      await preserveNativeScreenshotDrop(payload, new Map([[source, file]]), platform, save)
    ).toBe(payload)
    expect(file.arrayBuffer).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('leaves saved screenshots and non-agent drops alone', async () => {
    const file = droppedFile()
    const save = vi.fn()
    const path = '/Users/alice/Desktop/Screenshot.png'
    expect(
      await preserveNativeScreenshotDrop(
        { target: 'terminal', paths: [path] },
        new Map([[path, file]]),
        'darwin',
        save
      )
    ).toEqual({ target: 'terminal', paths: [path] })
    const payload = {
      target: 'file-explorer' as const,
      paths: [source],
      destinationDir: '/project'
    }
    expect(
      await preserveNativeScreenshotDrop(payload, new Map([[source, file]]), 'darwin', save)
    ).toBe(payload)
    expect(file.arrayBuffer).not.toHaveBeenCalled()
  })

  it('rejects oversized images before reading their bytes', async () => {
    const file = droppedFile(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1)
    const save = vi.fn()
    await expect(
      preserveNativeScreenshotDrop(
        { target: 'terminal', paths: [source] },
        new Map([[source, file]]),
        'darwin',
        save
      )
    ).rejects.toThrow('too large')
    expect(file.arrayBuffer).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('does not relay the inaccessible source when reading or saving fails', async () => {
    const file = droppedFile()
    const save = vi.fn().mockRejectedValue(new Error('disk full'))
    const args: Parameters<typeof preserveNativeScreenshotDrop> = [
      { target: 'terminal' as const, paths: [source] },
      new Map([[source, file]]),
      'darwin',
      save
    ]
    await expect(preserveNativeScreenshotDrop(...args)).rejects.toThrow('disk full')
    file.arrayBuffer.mockRejectedValue(new Error('File no longer available'))
    await expect(preserveNativeScreenshotDrop(...args)).rejects.toThrow('File no longer available')
    expect(save).toHaveBeenCalledOnce()
  })
})
