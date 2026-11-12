import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fitMobileAgentImageBase64 } from './mobile-agent-image-fit'

// Node has no image decoder or canvas: the fake decodes to fixed dimensions and records each encode.
function stubRaster(decoded: {
  width: number
  height: number
}): { width: number; height: number; type: string }[] {
  const encodes: { width: number; height: number; type: string }[] = []
  vi.stubGlobal(
    'Image',
    class {
      src = ''
      naturalWidth = decoded.width
      naturalHeight = decoded.height
      decode(): Promise<void> {
        return Promise.resolve()
      }
    }
  )
  vi.stubGlobal('document', {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ fillRect: () => {}, drawImage: () => {} }),
        toDataURL: (type: string) => {
          encodes.push({ width: canvas.width, height: canvas.height, type })
          return 'data:image/jpeg;base64,/9j/4AAQ'
        }
      }
      return canvas
    }
  })
  return encodes
}

function base64Of(header: number[] | string): string {
  const bytes = typeof header === 'string' ? Buffer.from(header, 'latin1') : Buffer.from(header)
  return Buffer.concat([bytes, Buffer.alloc(64)]).toString('base64')
}

const PNG = base64Of([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = base64Of([0xff, 0xd8, 0xff, 0xe0])
const HEIC = base64Of('\0\0\0\x18ftypheic')

describe('fitMobileAgentImageBase64', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('re-encodes a full-size photo as a 2000 px JPEG', async () => {
    const encodes = stubRaster({ width: 4032, height: 3024 })

    expect(await fitMobileAgentImageBase64(JPEG)).toBe('/9j/4AAQ')
    expect(encodes).toEqual([{ width: 2000, height: 1500, type: 'image/jpeg' }])
  })

  it('passes a small PNG through unchanged', async () => {
    const encodes = stubRaster({ width: 1200, height: 800 })

    expect(await fitMobileAgentImageBase64(PNG)).toBe(PNG)
    expect(encodes).toEqual([])
  })

  it('converts a small image agents cannot read to JPEG', async () => {
    const encodes = stubRaster({ width: 1200, height: 800 })

    expect(await fitMobileAgentImageBase64(HEIC)).toBe('/9j/4AAQ')
    expect(encodes).toEqual([{ width: 1200, height: 800, type: 'image/jpeg' }])
  })
})
