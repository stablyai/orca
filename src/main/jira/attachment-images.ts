import type { JiraClientForSite } from './client'
import { JiraApiError, jiraRequestBinary } from './client'
import type { JiraAdfMediaAttrs, JiraAdfMediaResolver } from './adf-markdown'

// Why: images are inlined as data URLs over IPC into the renderer. Keep totals
// modest so a screenshot-heavy ticket cannot balloon process memory.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGES = 12

export type JiraImageAttachment = {
  id: string
  filename: string
  mimeType: string
  dataUrl: string
}

type AttachmentMeta = {
  id: string
  filename: string
  mimeType: string
  size: number
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isImageMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase()
  return (
    normalized.startsWith('image/') && !normalized.includes('svg') // Why: SVG can carry script; stick to raster screenshots.
  )
}

function escapeMarkdownAlt(text: string): string {
  return text.replace(/[[\]]/g, '')
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
    metas.push({ id, filename, mimeType, size })
    if (metas.length >= MAX_IMAGES) {
      break
    }
  }
  return metas
}

/** Pull attachment content IDs from Jira rendered HTML in document order. */
export function extractAttachmentContentIdsFromHtml(html: string | undefined | null): string[] {
  if (!html) {
    return []
  }
  const ids: string[] = []
  const seen = new Set<string>()
  // Matches /rest/api/3/attachment/content/12345 and /secure/attachment/12345/...
  const pattern =
    /\/(?:rest\/api\/\d+\/attachment\/content|secure\/attachment)\/(\d+)(?:\/|\b|"|'|\?)/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const id = match[1]
    if (!id || seen.has(id)) {
      continue
    }
    seen.add(id)
    ids.push(id)
  }
  return ids
}

async function downloadImageAttachment(
  client: JiraClientForSite,
  meta: AttachmentMeta
): Promise<JiraImageAttachment | null> {
  try {
    const binary = await jiraRequestBinary(
      client,
      `/rest/api/3/attachment/content/${encodeURIComponent(meta.id)}?redirect=false`
    )
    if (binary.data.byteLength === 0 || binary.data.byteLength > MAX_IMAGE_BYTES) {
      return null
    }
    const contentType = binary.contentType.split(';')[0]?.trim() || meta.mimeType
    if (!isImageMimeType(contentType) && !isImageMimeType(meta.mimeType)) {
      return null
    }
    const mime = isImageMimeType(contentType) ? contentType : meta.mimeType
    const base64 = Buffer.from(binary.data).toString('base64')
    return {
      id: meta.id,
      filename: meta.filename,
      mimeType: mime,
      dataUrl: `data:${mime};base64,${base64}`
    }
  } catch (error) {
    // Why: one bad attachment should not blank the whole issue description.
    if (error instanceof JiraApiError && error.status === 404) {
      return null
    }
    console.warn('[jira] attachment image download failed:', meta.id, error)
    return null
  }
}

export async function loadIssueImageAttachments(
  client: JiraClientForSite,
  attachmentField: unknown,
  preferredIds: string[] = []
): Promise<JiraImageAttachment[]> {
  const metas = parseImageAttachmentMetas(attachmentField)
  if (metas.length === 0) {
    return []
  }

  const byId = new Map(metas.map((meta) => [meta.id, meta]))
  const ordered: AttachmentMeta[] = []
  const used = new Set<string>()

  for (const id of preferredIds) {
    const meta = byId.get(id)
    if (meta && !used.has(meta.id)) {
      ordered.push(meta)
      used.add(meta.id)
    }
  }
  for (const meta of metas) {
    if (!used.has(meta.id)) {
      ordered.push(meta)
      used.add(meta.id)
    }
  }

  const limited = ordered.slice(0, MAX_IMAGES)
  const downloaded = await Promise.all(limited.map((meta) => downloadImageAttachment(client, meta)))
  return downloaded.filter((image): image is JiraImageAttachment => image !== null)
}

export function createMediaMarkdownResolver(
  images: readonly JiraImageAttachment[],
  preferredAttachmentIds: readonly string[] = []
): JiraAdfMediaResolver {
  const byId = new Map(images.map((image) => [image.id, image]))
  const byFilename = new Map<string, JiraImageAttachment[]>()
  for (const image of images) {
    const key = image.filename.toLowerCase()
    const list = byFilename.get(key) ?? []
    list.push(image)
    byFilename.set(key, list)
  }

  // Prefer document-order attachment IDs from rendered HTML, then remaining images.
  const queue: JiraImageAttachment[] = []
  const queued = new Set<string>()
  for (const id of preferredAttachmentIds) {
    const image = byId.get(id)
    if (image && !queued.has(image.id)) {
      queue.push(image)
      queued.add(image.id)
    }
  }
  for (const image of images) {
    if (!queued.has(image.id)) {
      queue.push(image)
      queued.add(image.id)
    }
  }

  const take = (image: JiraImageAttachment | undefined): string | null => {
    if (!image) {
      return null
    }
    const index = queue.findIndex((entry) => entry.id === image.id)
    if (index >= 0) {
      queue.splice(index, 1)
    }
    return `![${escapeMarkdownAlt(image.filename)}](${image.dataUrl})`
  }

  return (attrs: JiraAdfMediaAttrs): string | null => {
    const alt = attrs.alt?.trim() || 'Image'
    if (attrs.url && /^https?:\/\//i.test(attrs.url)) {
      return `![${escapeMarkdownAlt(alt)}](${attrs.url})`
    }

    if (attrs.alt?.trim()) {
      const matches = byFilename.get(attrs.alt.trim().toLowerCase())
      if (matches && matches.length > 0) {
        const stillQueued = matches.find((image) => queue.some((entry) => entry.id === image.id))
        const resolved = take(stillQueued ?? matches[0])
        if (resolved) {
          return resolved
        }
      }
    }

    // Why: ADF media IDs are Media Service UUIDs, not attachment IDs. Pair remaining
    // inline images to downloaded attachments in rendered/document order.
    return take(queue.shift())
  }
}
