import { describe, expect, it, vi } from 'vitest'
import { createMediaRangeResponse } from './media-range-response'
import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'

function fixture(size = 10) {
  return {
    size,
    read: vi.fn(async (offset: number, length: number) =>
      Uint8Array.from({ length }, (_, index) => (offset + index) % 256)
    ),
    close: vi.fn(async () => {})
  }
}

describe('media range responses', () => {
  it.each([
    ['bytes=2-5', 'bytes 2-5/10', [2, 3, 4, 5]],
    ['bytes=7-', 'bytes 7-9/10', [7, 8, 9]],
    ['bytes=-3', 'bytes 7-9/10', [7, 8, 9]],
    ['bytes=8-100', 'bytes 8-9/10', [8, 9]]
  ] as const)('seeks using %s', async (range, contentRange, bytes) => {
    const reader = fixture()
    const response = await createMediaRangeResponse(
      new Request('https://video.test', { headers: { range } }),
      'video/mp4',
      reader
    )
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe(contentRange)
    expect(response.headers.get('Content-Length')).toBe(String(bytes.length))
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(bytes)
    expect(reader.close).toHaveBeenCalledTimes(1)
  })

  it.each([
    'bytes=10-',
    'bytes=5-2',
    'bytes=-0',
    'bytes=',
    'bytes=0-1,4-5',
    'bytes=9007199254740992-',
    'bytes=-9007199254740992'
  ])('refuses invalid range %s without reading', async (range) => {
    const reader = fixture()
    const response = await createMediaRangeResponse(
      new Request('https://video.test', { headers: { range } }),
      'video/mp4',
      reader
    )
    expect(response.status).toBe(416)
    expect(response.headers.get('Content-Range')).toBe('bytes */10')
    expect(reader.read).not.toHaveBeenCalled()
    expect(reader.close).toHaveBeenCalledTimes(1)
  })

  it('bounds reads when streaming a multi-gigabyte file and releases it on cancellation', async () => {
    const reader = fixture(4 * 1024 ** 3)
    const response = await createMediaRangeResponse(
      new Request('https://video.test'),
      'video/mp4',
      reader
    )
    expect(response.headers.get('Content-Length')).toBe(String(reader.size))
    const body = response.body?.getReader()
    expect((await body?.read())?.value?.byteLength).toBe(MAX_FILE_RANGE_READ_BYTES)
    await body?.cancel()
    expect(reader.read.mock.calls.every(([, length]) => length <= MAX_FILE_RANGE_READ_BYTES)).toBe(
      true
    )
    expect(reader.close).toHaveBeenCalledTimes(1)
  })

  it('answers HEAD and empty files without reading', async () => {
    for (const [method, size] of [
      ['HEAD', 10],
      ['GET', 0]
    ] as const) {
      const reader = fixture(size)
      const response = await createMediaRangeResponse(
        new Request('https://video.test', { method }),
        'video/mp4',
        reader
      )
      expect(response.status).toBe(200)
      expect(response.body).toBeNull()
      expect(reader.read).not.toHaveBeenCalled()
      expect(reader.close).toHaveBeenCalledTimes(1)
    }
  })

  it('closes a failed read and reports the stream error', async () => {
    const reader = fixture()
    reader.read.mockRejectedValue(new Error('Connection dropped'))
    const response = await createMediaRangeResponse(
      new Request('https://video.test'),
      'video/mp4',
      reader
    )
    await expect(response.arrayBuffer()).rejects.toThrow('Connection dropped')
    expect(reader.close).toHaveBeenCalledTimes(1)
  })

  it('releases a file when the request is aborted', async () => {
    const controller = new AbortController()
    const reader = fixture(4 * 1024 ** 3)
    const response = await createMediaRangeResponse(
      new Request('https://video.test', { signal: controller.signal }),
      'video/mp4',
      reader
    )
    controller.abort()
    await expect(response.arrayBuffer()).rejects.toThrow('Media request cancelled')
    expect(reader.close).toHaveBeenCalledTimes(1)
  })
})
