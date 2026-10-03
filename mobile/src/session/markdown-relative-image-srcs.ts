import { buildImageDataUri } from '../../../src/shared/image-data-uri'
import { classifyMobileArtifact } from './mobile-artifact-kind'
import {
  fileTabImageRead,
  type MobileFileTabDocRpcSender
} from '../files/mobile-file-tab-doc-operations'

/**
 * Repository-relative images for the markdown editor.
 *
 * The editor document's origin is a placeholder host, so `![alt](docs/a.png)` can only render
 * broken there. The session reads those files over the same `files.readPreview` a file tab's
 * image doc uses, and hands the data URLs to the editor keyed by the authored src — the document
 * keeps the authored src as its serialization source, so a displayed image never reaches the
 * saved file.
 */

/** Bounds the fan-out: one document resolves at most this many distinct relative images. */
const MAX_RESOLVED_IMAGE_SRCS = 24

/** Same grammar as the editor's own inline image token, minus the newlines it never sees. */
const INLINE_IMAGE_TOKEN = /!\[[^\]\n]*\]\([^)\n]+\)/g
const INLINE_IMAGE_SRC = /^!\[[^\]\n]*\]\(([^)\n]+)\)$/

const EXTERNAL_SRC = /^[a-z][a-z0-9+.-]*:/i

/**
 * What the editor's `<img>` can render, next to what a file tab's RN `<Image>` can. SVG is the
 * difference: the shared classifier excludes it because `<Image>` cannot decode it, while the
 * editor document's `<img>` renders it fine (and never scripts it, as an image subresource).
 */
function isEditorRenderableImagePath(path: string): boolean {
  return classifyMobileArtifact(path) === 'image' || /\.svg$/i.test(path)
}

/** The distinct non-external image srcs of a markdown document, in first-appearance order. */
export function collectMarkdownImageSrcs(content: string): string[] {
  const srcs: string[] = []
  for (const token of content.match(INLINE_IMAGE_TOKEN) ?? []) {
    const src = INLINE_IMAGE_SRC.exec(token)?.[1]
    if (
      src &&
      !EXTERNAL_SRC.test(src) &&
      !src.startsWith('//') &&
      !src.startsWith('#') &&
      !srcs.includes(src)
    ) {
      srcs.push(src)
    }
  }
  return srcs
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    // A malformed escape is the literal name the author wrote; the read decides if it exists.
    return segment
  }
}

/**
 * Resolves one image src against the markdown document's worktree-relative path.
 *
 * `/`-rooted srcs are worktree-rooted, matching how the desktop preview resolves them. A src that
 * climbs out of the worktree has no file to read, so it stays the broken image it already was.
 */
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

/**
 * Reads every relative image of a markdown document and answers the authored-src → data-URL map
 * the editor displays from. A missing, unreadable, or oversize image is simply absent from the
 * map, which leaves the editor's existing broken image in place rather than failing the document.
 */
export async function readMarkdownImageSources(
  client: MobileFileTabDocRpcSender,
  worktreeId: string,
  markdownRelativePath: string,
  content: string
): Promise<Record<string, string>> {
  const sources: Record<string, string> = {}
  await Promise.all(
    collectMarkdownImageSrcs(content)
      .slice(0, MAX_RESOLVED_IMAGE_SRCS)
      .map(async (rawSrc) => {
        const relativePath = resolveMarkdownRelativeImagePath(rawSrc, markdownRelativePath)
        if (!relativePath || !isEditorRenderableImagePath(relativePath)) {
          return
        }
        try {
          const reply = await fileTabImageRead.request(client, {
            worktree: `id:${worktreeId}`,
            relativePath
          })
          const preview = fileTabImageRead.interpret(reply)
          const dataUri =
            preview.isImage === true ? buildImageDataUri(preview.mimeType, preview.content) : null
          if (dataUri) {
            sources[rawSrc] = dataUri
          }
        } catch {
          // A refused read keeps the broken image; the document itself already loaded.
        }
      })
  )
  return sources
}
