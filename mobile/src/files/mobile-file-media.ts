import { MEDIA_FILE_MIME_TYPES } from '../../../src/shared/media-file-extensions'

export const PDF_MIME_TYPE = 'application/pdf'

export type MobileFileMedia = {
  worktreeId: string
  relativePath: string
  mimeType: string
}

export function mobileFileMedia(worktreeId: string, relativePath?: string): MobileFileMedia | null {
  const mimeType = relativePath ? mobileFileMediaMime(relativePath) : null
  return relativePath && mimeType ? { worktreeId, relativePath, mimeType } : null
}

// PDFs count as media because they share the download-then-device-viewer path, opened by the shell instead of a <video>.
const MOBILE_FILE_MEDIA_MIME_TYPES: Record<string, string> = {
  ...MEDIA_FILE_MIME_TYPES,
  '.pdf': PDF_MIME_TYPE
}

export function mobileFileMediaMime(path: string): string | null {
  const name = path.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? (MOBILE_FILE_MEDIA_MIME_TYPES[name.slice(dot).toLowerCase()] ?? null) : null
}
