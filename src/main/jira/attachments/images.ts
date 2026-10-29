import type { JiraClientForSite } from '../authenticated-request'
import { attachmentContentUrl } from './content-url'
import { jiraRequestBinary } from '../authenticated-request'
import { JiraApiError } from '../jira-api-error'
import type { JiraAdfMediaAttrs, JiraAdfMediaResolver } from '../adf-markdown'
import { escapeMarkdownAlt, unresolvedMediaPlaceholder } from '../adf-markdown'
import { escapeMarkdownLinkDestination } from '../adf-media-destination'
import { loadAttachmentDataUrlWithCache } from './image-cache'
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_TOTAL_IMAGE_BYTES,
  parseImageAttachmentMetas,
  isImageMimeType,
  type AttachmentMeta
} from './meta'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import {
  JIRA_IMAGE_MAX_BYTES,
  JIRA_IMAGE_MAX_REFERENCES,
  type JiraMediaFormat
} from '../../../shared/jira/jira-attachment-image'
import { registerAttachmentImageGrant } from './image-grants'

const DOWNLOAD_CONCURRENCY = 3

export type JiraImageAttachment = {
  id: string
  filename: string
  mimeType: string
  byteSize: number
  dataUrl: string
}

async function downloadImageAttachment(
  client: JiraClientForSite,
  meta: AttachmentMeta
): Promise<JiraImageAttachment | null> {
  if (!meta.contentUrl && client.site.authType === 'server') {
    // Server/DC exposes attachment bytes through the metadata-provided content URI.
    return null
  }

  const dataUrl = await loadAttachmentDataUrlWithCache({
    siteId: client.site.id,
    attachmentId: meta.id,
    load: async () => {
      try {
        const contentUrl = attachmentContentUrl(client.site, meta)
        if (!contentUrl) {
          return null
        }
        const binary = await jiraRequestBinary(client, contentUrl.toString())
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
          dataUrl: `data:${mime};base64,${base64}`,
          byteSize: binary.data.byteLength
        }
      } catch (error) {
        // A missing attachment must not blank the whole issue.
        if (error instanceof JiraApiError && error.status === 404) {
          return null
        }
        console.warn('[jira] attachment image download failed:', meta.id, error)
        return null
      }
    }
  })

  if (!dataUrl) {
    return null
  }

  const mimeMatch = /^data:([^;]+);base64,/.exec(dataUrl)
  const mime = mimeMatch?.[1] || meta.mimeType
  // Approximate byte size from base64 payload when served from cache.
  const base64Part = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : ''
  const byteSize = Math.floor((base64Part.length * 3) / 4)
  if (byteSize === 0 || byteSize > MAX_IMAGE_BYTES) {
    return null
  }

  return {
    id: meta.id,
    filename: meta.filename,
    mimeType: mime,
    byteSize,
    dataUrl
  }
}

export async function loadIssueImageAttachments(
  client: JiraClientForSite,
  attachmentField: unknown,
  preferredIds: string[] = [],
  mediaFormat?: JiraMediaFormat
): Promise<JiraImageAttachment[]> {
  const metas = parseImageAttachmentMetas(
    attachmentField,
    mediaFormat ? JIRA_IMAGE_MAX_BYTES : MAX_IMAGE_BYTES
  )
  if (metas.length === 0 || preferredIds.length === 0) {
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

  if (mediaFormat === 'reference') {
    return ordered.slice(0, JIRA_IMAGE_MAX_REFERENCES).map((meta) => ({
      id: meta.id,
      filename: meta.filename,
      mimeType: meta.mimeType,
      byteSize: meta.size,
      dataUrl: registerAttachmentImageGrant(client, meta)
    }))
  }

  // Enforce declared-size budgets before concurrent downloads fetch bytes that would be discarded.
  const toDownload: AttachmentMeta[] = []
  let plannedBytes = 0
  for (const meta of ordered.slice(0, MAX_IMAGES)) {
    if (meta.size > 0 && plannedBytes + meta.size > MAX_TOTAL_IMAGE_BYTES) {
      continue
    }
    toDownload.push(meta)
    if (meta.size > 0) {
      plannedBytes += meta.size
    }
  }

  const downloaded = await mapWithConcurrency(toDownload, DOWNLOAD_CONCURRENCY, (meta) =>
    downloadImageAttachment(client, meta)
  )

  const images: JiraImageAttachment[] = []
  let totalBytes = 0
  for (const image of downloaded) {
    if (!image) {
      continue
    }
    if (totalBytes + image.byteSize > MAX_TOTAL_IMAGE_BYTES) {
      continue
    }
    totalBytes += image.byteSize
    images.push(image)
  }
  return images
}

export type MediaResolutionStats = {
  /** Attachment-needing media nodes that resolved to an image destination. */
  attachmentResolvedCount: number
}

export function createMediaMarkdownResolver(
  images: readonly JiraImageAttachment[],
  preferredAttachmentIds: readonly string[] = [],
  stats?: MediaResolutionStats
): JiraAdfMediaResolver {
  const byId = new Map(images.map((image) => [image.id, image]))
  const byFilename = new Map<string, JiraImageAttachment[]>()
  const resolvedByMediaId = new Map<string, string>()
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
    // Consumed filename matches must fall through to positional pairing.
    if (index === -1) {
      return null
    }
    queue.splice(index, 1)
    return `![${escapeMarkdownAlt(image.filename)}](${image.dataUrl})`
  }

  return (attrs: JiraAdfMediaAttrs): string | null => {
    if (attrs.id) {
      const cached = resolvedByMediaId.get(attrs.id)
      if (cached) {
        if (stats && cached.startsWith('![')) {
          stats.attachmentResolvedCount += 1
        }
        return cached
      }
    }
    const alt = attrs.alt?.trim() || 'Image'
    if (attrs.url) {
      // Return a placeholder so unsafe external URLs cannot fall through to attachment pairing.
      if (!/^https?:\/\//i.test(attrs.url)) {
        return unresolvedMediaPlaceholder({ ...attrs, alt })
      }
      const safeUrl = escapeMarkdownLinkDestination(attrs.url)
      if (!safeUrl) {
        return unresolvedMediaPlaceholder({ ...attrs, alt })
      }
      // External success does not count toward attachment needCount.
      return `![${escapeMarkdownAlt(alt)}](${safeUrl})`
    }

    let resolved: string | null = null
    // ADF media UUIDs are not attachment IDs; pair by filename or document order.
    if (attrs.alt?.trim()) {
      const matches = byFilename.get(attrs.alt.trim().toLowerCase())
      if (matches && matches.length > 0) {
        const stillQueued = matches.find((image) => queue.some((entry) => entry.id === image.id))
        if (stillQueued) {
          resolved = take(stillQueued)
        }
      }
    }

    // take() checks membership and removes; shifting first would make it fail.
    if (!resolved && queue.length > 0) {
      resolved = take(queue[0])
    }
    if (resolved && attrs.id) {
      resolvedByMediaId.set(attrs.id, resolved)
    }
    if (resolved && stats) {
      stats.attachmentResolvedCount += 1
    }
    return resolved
  }
}
