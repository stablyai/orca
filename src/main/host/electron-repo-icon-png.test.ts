import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createFromBuffer } = vi.hoisted(() => ({ createFromBuffer: vi.fn() }))
vi.mock('electron', () => ({ nativeImage: { createFromBuffer } }))

import { encodeRepoIconPng } from './electron-repo-icon-png'

function fakeImage(width: number, height: number, png = Buffer.from([1])) {
  const image = {
    isEmpty: () => width === 0,
    getSize: () => ({ width, height }),
    resize: vi.fn((size: { width: number; height: number }) => fakeImage(size.width, size.height)),
    toPNG: () => png
  }
  return image
}

describe('encodeRepoIconPng', () => {
  beforeEach(() => createFromBuffer.mockReset())

  it('scales the long edge down to the limit, keeping the aspect ratio', () => {
    const image = fakeImage(400, 200)
    createFromBuffer.mockReturnValue(image)

    expect(encodeRepoIconPng(new Uint8Array([9]), 64)).toEqual(Buffer.from([1]))
    expect(image.resize).toHaveBeenCalledWith({ width: 64, height: 32, quality: 'best' })
  })

  it('never upscales a small icon', () => {
    const image = fakeImage(16, 16)
    createFromBuffer.mockReturnValue(image)

    encodeRepoIconPng(new Uint8Array([9]), 64)
    expect(image.resize).not.toHaveBeenCalled()
  })

  it('answers null for bytes the decoder cannot read', () => {
    createFromBuffer.mockReturnValue(fakeImage(0, 0))
    expect(encodeRepoIconPng(new Uint8Array([9]), 64)).toBeNull()
  })
})
