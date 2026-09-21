import type { JiraClientForSite } from './authenticated-request'
import { JiraApiError, apiBasePath, jiraRequestBinary } from './authenticated-request'
import type { JiraAdfMediaAttrs, JiraAdfMediaResolver } from './adf-markdown'
import { escapeMarkdownAlt, unresolvedMediaPlaceholder } from './adf-markdown'
import { escapeMarkdownLinkDestination } from './adf-media-destination'
import { loadAttachmentDataUrlWithCache } from './attachment-image-cache'
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_TOTAL_IMAGE_BYTES,
  parseImageAttachmentMetas,
  isImageMimeType,
  type AttachmentMeta
} from './attachment-meta'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'

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
        const contentUrl = meta.contentUrl
          ? new URL(meta.contentUrl, `${client.site.siteUrl}/`)
          : // Why: Cloud fallback uses apiBasePath so Server sites that lack contentUrl
            // still hit /rest/api/2 if ever called; Server still requires content metadata.
            new URL(
              `${apiBasePath(client.site)}/attachment/content/${encodeURIComponent(meta.id)}`,
              client.site.siteUrl
            )
        if (/\/rest\/api\/(?:2|3)\/attachment\/content\/[^/]+$/i.test(contentUrl.pathname)) {
          contentUrl.searchParams.set('redirect', 'false')
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
        // Why: one bad attachment should not blank the whole issue description.
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
  preferredIds: string[] = []
): Promise<JiraImageAttachment[]> {
  const metas = parseImageAttachmentMetas(attachmentField)
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

  // Why: pre-select by declared size so concurrent downloads do not fetch bodies
  // that will be dropped by the total budget after completion.
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
  /** Attachment-needing media nodes that successfully resolved to a data: image. */
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
    // Why: already-consumed images must not re-emit; fall through to positional pairing.
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
        if (stats && !cached.startsWith('*[') && cached.includes('data:')) {
          stats.attachmentResolvedCount += 1
        }
        return cached
      }
    }
    const alt = attrs.alt?.trim() || 'Image'
    if (attrs.url) {
      // Why: return placeholder (not null) so non-http / hostile externals do not
      // fall through to positional attachment pairing.
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
    // Why: ADF media IDs are Media Service UUIDs, not attachment IDs — skip byId
    // lookup on attrs.id against attachment map (they never match).
    if (attrs.alt?.trim()) {
      const matches = byFilename.get(attrs.alt.trim().toLowerCase())
      if (matches && matches.length > 0) {
        const stillQueued = matches.find((image) => queue.some((entry) => entry.id === image.id))
        // Why: only take still-queued matches; never re-emit matches[0] after consume.
        if (stillQueued) {
          resolved = take(stillQueued)
        }
      }
    }

    // Why: take() removes from queue; do not shift first or membership check fails.
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
