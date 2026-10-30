import { extname } from 'node:path'

const IMAGE_FORMATS: Record<string, string> = {
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}

export function classifyFile(src: string): { mimeType: string; ext: string } | null {
  const ext = extname(src).toLowerCase()
  const mime = IMAGE_FORMATS[ext]
  if (!mime) {
    return null
  }
  return { mimeType: mime, ext }
}
