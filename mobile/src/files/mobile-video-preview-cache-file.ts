import { File as FsFile, Paths } from 'expo-file-system'

// Native players (AVPlayer/ExoPlayer) only open a real file — they reject base64
// data URIs — so a video preview is staged in the cache directory first. The
// extension has to match the container: AVPlayer picks its demuxer from it.
const VIDEO_PREVIEW_FILE_PREFIX = 'orca-video-preview-'
const VIDEO_PREVIEW_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov'
}

// Named after the source path so re-opening the same file reuses one cache slot
// instead of leaking a staged copy per visit.
export function mobileVideoPreviewFileName(sourcePath: string, mimeType: string): string {
  const extension = VIDEO_PREVIEW_EXTENSIONS[mimeType.toLowerCase()] ?? 'mp4'
  return `${VIDEO_PREVIEW_FILE_PREFIX}${hashPreviewSourcePath(sourcePath)}.${extension}`
}

export function writeMobileVideoPreviewFile(fileName: string, base64: string): string {
  const file = new FsFile(Paths.cache, fileName)
  file.create({ overwrite: true })
  file.write(base64, { encoding: 'base64' })
  return file.uri
}

export function deleteMobileVideoPreviewFile(uri: string): void {
  try {
    new FsFile(uri).delete()
  } catch {
    // Best-effort: the OS reclaims the cache directory, and a failed unlink must
    // not break navigating away from the preview.
  }
}

// FNV-1a: repository paths contain separators and unicode that can't go in a file name.
function hashPreviewSourcePath(sourcePath: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < sourcePath.length; index += 1) {
    hash ^= sourcePath.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
