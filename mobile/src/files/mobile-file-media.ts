import { MEDIA_FILE_MIME_TYPES } from '../../../src/shared/media-file-extensions'

export type MobileFileMedia = {
  worktreeId: string
  relativePath: string
  mimeType: string
}

export function mobileFileMedia(worktreeId: string, relativePath?: string): MobileFileMedia | null {
  const mimeType = relativePath ? mobileFileMediaMime(relativePath) : null
  return relativePath && mimeType ? { worktreeId, relativePath, mimeType } : null
}

export function mobileFileMediaMime(path: string): string | null {
  const name = path.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? (MEDIA_FILE_MIME_TYPES[name.slice(dot).toLowerCase()] ?? null) : null
}
