import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'

const IMAGE_MEDIA_TYPES = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
} as const

export function providerAttachmentUri(path: string): string {
  if (!statSync(path).isFile()) {
    throw new Error(`attachment_not_file:${path}`)
  }
  return pathToFileURL(path).href
}

export function providerImageData(path: string): {
  mediaType: (typeof IMAGE_MEDIA_TYPES)[keyof typeof IMAGE_MEDIA_TYPES]
  data: string
} {
  providerAttachmentUri(path)
  const mediaType = IMAGE_MEDIA_TYPES[extname(path).toLowerCase() as keyof typeof IMAGE_MEDIA_TYPES]
  if (!mediaType) {
    throw new Error(`attachment_type_unsupported:${path}`)
  }
  return { mediaType, data: readFileSync(path).toString('base64') }
}
