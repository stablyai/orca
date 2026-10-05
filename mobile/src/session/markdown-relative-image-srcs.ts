import { decodeMarkdownEntities } from '../components/rich-markdown/markdown-escaping'
import { buildImageDataUri } from '../../../src/shared/image-data-uri'
import { readRasterImagePreviewDimensions } from '../../../src/shared/raster-image-base64-preview'
import {
  isKnownRasterImageMimeType,
  MAX_RASTER_IMAGE_PREVIEW_PIXELS
} from '../../../src/shared/raster-image-preview-limits'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../src/shared/remote-runtime-memory-limits'
import { getUtf8ByteLength } from '../../../src/shared/utf8-byte-limits'
import { classifyMobileArtifact } from './mobile-artifact-kind'
import {
  fileTabImageRead,
  type MobileFileTabDocRpcSender
} from '../files/mobile-file-tab-doc-operations'

// Bound per-document preview reads.
const MAX_RESOLVED_IMAGE_SRCS = 24
const MAX_CONCURRENT_IMAGE_READS = 2

const INLINE_IMAGE_TOKEN = /!\[[^\]\n]*\]\([^)\n]+\)/g
const INLINE_IMAGE_SRC = /^!\[[^\]\n]*\]\(([^)\n]+)\)$/

const EXTERNAL_SRC = /^[a-z][a-z0-9+.-]*:/i

function isEditorRenderableImagePath(path: string): boolean {
  return classifyMobileArtifact(path) === 'image' || /\.svg$/i.test(path)
}

export function collectMarkdownImageSrcs(content: string): string[] {
  const srcs = new Set<string>()
  for (const token of content.match(INLINE_IMAGE_TOKEN) ?? []) {
    const rawSrc = INLINE_IMAGE_SRC.exec(token)?.[1]
    const src = rawSrc ? decodeMarkdownEntities(rawSrc) : undefined
    if (src && !EXTERNAL_SRC.test(src) && !src.startsWith('//') && !src.startsWith('#')) {
      srcs.add(src)
    }
  }
  return [...srcs]
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    // Keep malformed escapes as literal filenames.
    return segment
  }
}

export function resolveMarkdownRelativeImagePath(
  rawSrc: string,
  markdownRelativePath: string
): string | null {
  const pathOnly = rawSrc.replace(/[?#].*$/, '')
  if (!pathOnly) {
    return null
  }
  const rooted = pathOnly.startsWith('/')
  const segments = rooted
    ? []
    : markdownRelativePath
        .split('/')
        .slice(0, -1)
        .filter((part) => part.length > 0 && part !== '.')
  for (const part of (rooted ? pathOnly.slice(1) : pathOnly).split('/')) {
    const segment = decodeSegment(part)
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (segments.pop() === undefined) {
        return null
      }
      continue
    }
    segments.push(segment)
  }
  return segments.length > 0 ? segments.join('/') : null
}

export async function readMarkdownImageSources(
  client: MobileFileTabDocRpcSender,
  worktreeId: string,
  markdownRelativePath: string,
  content: string
): Promise<Record<string, string>> {
  const sources: Record<string, string> = {}
  const srcs = collectMarkdownImageSrcs(content).slice(0, MAX_RESOLVED_IMAGE_SRCS)
  let mapBytes = 2
  let rasterPixels = 0
  for (let index = 0; index < srcs.length; index += MAX_CONCURRENT_IMAGE_READS) {
    const previews = await Promise.all(
      srcs.slice(index, index + MAX_CONCURRENT_IMAGE_READS).map(async (rawSrc) => {
        const relativePath = resolveMarkdownRelativeImagePath(rawSrc, markdownRelativePath)
        if (!relativePath || !isEditorRenderableImagePath(relativePath)) {
          return null
        }
        try {
          const reply = await fileTabImageRead.request(client, {
            worktree: `id:${worktreeId}`,
            relativePath
          })
          const preview = fileTabImageRead.interpret(reply)
          const dataUri =
            preview.isImage === true ? buildImageDataUri(preview.mimeType, preview.content) : null
          if (!dataUri) {
            return null
          }
          const dimensions = isKnownRasterImageMimeType(preview.mimeType)
            ? readRasterImagePreviewDimensions(preview.content)
            : null
          const pixels = dimensions
            ? dimensions.width * dimensions.height
            : isKnownRasterImageMimeType(preview.mimeType)
              ? MAX_RASTER_IMAGE_PREVIEW_PIXELS
              : 0
          return { rawSrc, dataUri, pixels }
        } catch {
          // A refused read keeps the placeholder; text already loaded.
          return null
        }
      })
    )
    // Admit in authored order, independent of host reply timing.
    for (const preview of previews) {
      if (!preview) {
        continue
      }
      const { rawSrc, dataUri, pixels } = preview
      const entryBytes =
        getUtf8ByteLength(JSON.stringify({ [rawSrc]: dataUri })) - 2 + (mapBytes > 2 ? 1 : 0)
      if (
        mapBytes + entryBytes > REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES ||
        rasterPixels + pixels > MAX_RASTER_IMAGE_PREVIEW_PIXELS
      ) {
        continue
      }
      sources[rawSrc] = dataUri
      mapBytes += entryBytes
      rasterPixels += pixels
    }
  }
  return sources
}
