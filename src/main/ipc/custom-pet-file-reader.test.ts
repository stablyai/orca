import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_CUSTOM_PET_FILE_BYTES } from '../../shared/custom-pet-media-limits'

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }))

vi.mock('node:fs/promises', () => ({ open: openMock }))

import { CustomPetFileTooLargeError, readCustomPetFile } from './custom-pet-file-reader'

function fileHandle({
  afterSize,
  beforeSize,
  extraByte = false
}: {
  afterSize?: number
  beforeSize: number
  extraByte?: boolean
}) {
  let statCalls = 0
  return {
    close: vi.fn().mockResolvedValue(undefined),
    read: vi.fn(async (target: Buffer, offset: number, length: number, position: number) => {
      if (position < beforeSize) {
        const bytesRead = Math.min(length, beforeSize - position)
        target.fill(0x2a, offset, offset + bytesRead)
        return { bytesRead, buffer: target }
      }
      if (extraByte) {
        target[offset] = 0x2b
        return { bytesRead: 1, buffer: target }
      }
      return { bytesRead: 0, buffer: target }
    }),
    stat: vi.fn(async () => {
      statCalls += 1
      return {
        isFile: () => true,
        size: statCalls === 1 ? beforeSize : (afterSize ?? beforeSize)
      }
    })
  }
}

beforeEach(() => openMock.mockReset())

describe('readCustomPetFile', () => {
  it('reads a stable file into an exact ArrayBuffer', async () => {
    const handle = fileHandle({ beforeSize: 3 })
    openMock.mockResolvedValue(handle)

    const result = await readCustomPetFile('/stored/pet.png')

    expect([...new Uint8Array(result)]).toEqual([0x2a, 0x2a, 0x2a])
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('rejects an oversized file before issuing a read allocation', async () => {
    const handle = fileHandle({ beforeSize: MAX_CUSTOM_PET_FILE_BYTES + 1 })
    openMock.mockResolvedValue(handle)

    await expect(readCustomPetFile('/stored/replaced-pet.png')).rejects.toBeInstanceOf(
      CustomPetFileTooLargeError
    )
    expect(handle.read).not.toHaveBeenCalled()
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('rejects a file that grows between its handle stat and bounded read', async () => {
    const handle = fileHandle({ beforeSize: 3, afterSize: 4, extraByte: true })
    openMock.mockResolvedValue(handle)

    await expect(readCustomPetFile('/stored/growing-pet.png')).rejects.toThrow(
      'changed while it was being read'
    )
    expect(handle.close).toHaveBeenCalledOnce()
  })
})
