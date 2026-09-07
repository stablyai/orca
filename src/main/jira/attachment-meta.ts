// Why: image inlined as data URLs over IPC — keep per-image and selection caps modest.
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const MAX_TOTAL_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGES = 12

export type AttachmentMeta = {
  id: string
  filename: string
  mimeType: string
  size: number
  contentUrl?: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function isImageMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase()
  return (
    normalized.startsWith('image/') && !normalized.includes('svg') // Why: SVG can carry script; stick to raster screenshots.
  )
}

export function parseImageAttachmentMetas(attachmentField: unknown): AttachmentMeta[] {
  if (!Array.isArray(attachmentField)) {
    return []
  }
  const metas: AttachmentMeta[] = []
  for (const item of attachmentField) {
    const record = asRecord(item)
    const id = asString(record.id) || (typeof record.id === 'number' ? String(record.id) : '')
    const filename = asString(record.filename) || `attachment-${id}`
    const mimeType = asString(record.mimeType)
    const size = typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : 0
    if (!id || !isImageMimeType(mimeType)) {
      continue
    }
    if (size > MAX_IMAGE_BYTES) {
      continue
    }
    const contentUrl = asString(record.content)
    metas.push({
      id,
      filename,
      mimeType,
      size,
      ...(contentUrl ? { contentUrl } : {})
    })
  }
  return metas
}
