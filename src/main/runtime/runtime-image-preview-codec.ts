import { createJimp } from '@jimp/core'
import png from '@jimp/js-png'
import jpeg from '@jimp/js-jpeg'
import { methods } from '@jimp/plugin-resize'
import { setImmediate } from 'node:timers/promises'

const PreviewImage = createJimp({ formats: [png, jpeg], plugins: [methods] })

export async function shrinkImagePreview(
  source: Buffer,
  maxBytes: number
): Promise<{ bytes: Buffer; mimeType: string }> {
  const image = await PreviewImage.fromBuffer(source, {
    'image/jpeg': { maxResolutionInMP: 32, maxMemoryUsageInMB: 256 }
  })
  let transparent = false
  for (let offset = 3; offset < image.bitmap.data.length; offset += 4) {
    if (image.bitmap.data[offset] < 255) {
      transparent = true
      break
    }
  }
  const mimeType = transparent ? 'image/png' : 'image/jpeg'
  let edge = Math.min(2048, Math.max(image.width, image.height))
  for (let attempt = 0; attempt < 12; attempt++) {
    await setImmediate()
    image.scaleToFit({ w: edge, h: edge })
    const bytes = transparent
      ? await image.getBuffer('image/png')
      : await image.getBuffer('image/jpeg', { quality: 85 })
    if (bytes.length <= maxBytes) return { bytes, mimeType }
    edge = Math.max(1, Math.floor(edge * 0.7))
  }
  throw new Error('file_too_large')
}
