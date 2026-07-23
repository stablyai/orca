import { describe, expect, it, vi } from 'vitest'
import { readStableRuntimeUploadFile } from './filesystem-runtime-upload-file-reader'

function createRead(content: Buffer, maxBytesPerRead = content.byteLength) {
  return vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
    const bytesRead = Math.min(length, maxBytesPerRead, Math.max(0, content.byteLength - position))
    if (bytesRead > 0) {
      content.copy(buffer, offset, position, position + bytesRead)
    }
    return { buffer, bytesRead }
  })
}

describe('runtime upload file reader', () => {
  it('preserves an exact-size file across partial reads', async () => {
    const content = Buffer.from('bounded-content')
    const read = createRead(content, 3)

    await expect(
      readStableRuntimeUploadFile({ read }, content.byteLength, 'asset.bin')
    ).resolves.toEqual(content)
    expect(read).toHaveBeenLastCalledWith(expect.any(Buffer), 0, 1, content.byteLength)
  })

  it('rejects a file that becomes shorter without exposing uninitialized bytes', async () => {
    const content = Buffer.from('short')

    await expect(
      readStableRuntimeUploadFile({ read: createRead(content) }, content.byteLength + 1, '')
    ).rejects.toThrow("File changed during upload staging: ''")
  })

  it('uses a one-byte probe and rejects growth beyond the admitted size', async () => {
    const content = Buffer.from('growth')
    const admittedBytes = content.byteLength - 1
    const read = createRead(content)

    await expect(
      readStableRuntimeUploadFile({ read }, admittedBytes, 'growth.bin')
    ).rejects.toThrow("File changed during upload staging: 'growth.bin'")
    expect(read).toHaveBeenNthCalledWith(1, expect.any(Buffer), 0, admittedBytes, 0)
    expect(read).toHaveBeenNthCalledWith(2, expect.any(Buffer), 0, 1, admittedBytes)
  })
})
