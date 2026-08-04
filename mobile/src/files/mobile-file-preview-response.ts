import { classifyMobileArtifact } from '../session/mobile-artifact-kind'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import { isMarkdownPath } from './file-tree'
import { isTerminalArtifactGrantError } from './terminal-artifact-grant-error'

export type MobileFilePreviewTextKind = 'html' | 'markdown' | 'text'

export type MobileFilePreviewResult =
  | {
      status: 'loading'
      message: string
    }
  | {
      status: 'waiting'
      message: string
      reconnect: true
    }
  | {
      status: 'ready'
      kind: 'image'
      dataUri: string
    }
  | {
      status: 'ready'
      kind: 'video'
      // Kept as raw base64 (not a data URI): the player needs the bytes on disk,
      // and re-splitting a multi-megabyte data URI would double peak memory.
      base64: string
      mimeType: string
    }
  | {
      status: 'ready'
      kind: MobileFilePreviewTextKind
      content: string
      truncated: boolean
      byteLength: number
    }
  | {
      status: 'empty'
      kind: MobileFilePreviewTextKind
    }
  | {
      status: 'error'
      message: string
      reconnect: boolean
    }

export function normalizeMobileFilePreviewResponse(
  relativePath: string,
  response: RpcResponse
): MobileFilePreviewResult {
  if (!response.ok) {
    return previewError(
      (response as RpcFailure).error.message || (response as RpcFailure).error.code
    )
  }

  const result = (response as RpcSuccess).result
  const artifactKind = classifyMobileArtifact(relativePath)
  if (artifactKind === 'image') {
    return normalizeImagePreviewResult(result)
  }
  if (artifactKind === 'video') {
    return normalizeVideoPreviewResult(result)
  }
  return normalizeTextPreviewResult(relativePath, result)
}

// Text arms carry editable content; image/video previews never do.
export function isMobileFilePreviewTextResult(
  result: MobileFilePreviewResult
): result is Extract<
  MobileFilePreviewResult,
  { status: 'ready'; kind: MobileFilePreviewTextKind }
> {
  return result.status === 'ready' && result.kind !== 'image' && result.kind !== 'video'
}

export function previewError(message: string): MobileFilePreviewResult {
  const normalized = message.toLowerCase()
  if (normalized === 'binary_file' || normalized.includes('binary_file')) {
    return { status: 'error', message: 'Binary preview unavailable', reconnect: false }
  }
  if (normalized === 'file_too_large' || normalized.includes('file_too_large')) {
    return { status: 'error', message: 'File too large for mobile preview', reconnect: false }
  }
  if (isTerminalArtifactGrantError(normalized)) {
    return { status: 'error', message: 'Reload preview before saving', reconnect: false }
  }
  if (
    normalized.includes('remote connection dropped') ||
    normalized.includes('provider unavailable') ||
    normalized.includes('disconnected') ||
    normalized.includes('reconnect the ssh target')
  ) {
    return { status: 'error', message: 'Unable to reach the desktop filesystem', reconnect: true }
  }
  if (
    normalized.includes('enoent') ||
    normalized.includes('no such file') ||
    normalized.includes('not found') ||
    normalized.includes('does not exist')
  ) {
    return { status: 'error', message: 'File not found', reconnect: false }
  }
  return { status: 'error', message: 'Unable to load preview', reconnect: false }
}

export function formatPreviewByteLength(byteLength: number): string {
  if (!Number.isFinite(byteLength) || byteLength < 0) {
    return 'unknown size'
  }
  if (byteLength < 1024) {
    return `${byteLength} B`
  }
  if (byteLength < 1024 * 1024) {
    return `${Math.round(byteLength / 1024)} KB`
  }
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`
}

function normalizeImagePreviewResult(result: unknown): MobileFilePreviewResult {
  const media = readBinaryPreviewMedia(result, 'isImage')
  if (!media) {
    return previewError('binary_file')
  }
  return {
    status: 'ready',
    kind: 'image',
    dataUri: `data:${media.mimeType};base64,${media.content}`
  }
}

function normalizeVideoPreviewResult(result: unknown): MobileFilePreviewResult {
  const media = readBinaryPreviewMedia(result, 'isVideo')
  if (!media) {
    return previewError('binary_file')
  }
  return { status: 'ready', kind: 'video', base64: media.content, mimeType: media.mimeType }
}

function readBinaryPreviewMedia(
  result: unknown,
  flag: 'isImage' | 'isVideo'
): { content: string; mimeType: string } | null {
  if (!result || typeof result !== 'object') {
    return null
  }
  const preview = result as Record<string, unknown>
  if (
    preview.isBinary !== true ||
    preview[flag] !== true ||
    typeof preview.mimeType !== 'string' ||
    preview.mimeType.length === 0 ||
    typeof preview.content !== 'string' ||
    preview.content.length === 0
  ) {
    return null
  }
  return { content: preview.content, mimeType: preview.mimeType }
}

function normalizeTextPreviewResult(
  relativePath: string,
  result: unknown
): MobileFilePreviewResult {
  if (!result || typeof result !== 'object') {
    return previewError('Unable to load preview')
  }
  const preview = result as {
    content?: unknown
    truncated?: unknown
    byteLength?: unknown
    isBinary?: unknown
  }
  if (preview.isBinary === true) {
    return previewError('binary_file')
  }
  if (typeof preview.content !== 'string') {
    return previewError('Unable to load preview')
  }
  const kind = textKindForPreviewPath(relativePath)
  if (preview.content.length === 0) {
    return { status: 'empty', kind }
  }
  return {
    status: 'ready',
    kind,
    content: preview.content,
    truncated: preview.truncated === true,
    byteLength: typeof preview.byteLength === 'number' ? preview.byteLength : preview.content.length
  }
}

function textKindForPreviewPath(relativePath: string): MobileFilePreviewTextKind {
  if (classifyMobileArtifact(relativePath) === 'html') {
    return 'html'
  }
  return isMarkdownPath(relativePath) ? 'markdown' : 'text'
}
