import type { MobileFileMedia } from './mobile-file-media'
import { classifyMobileArtifact } from '../session/mobile-artifact-kind'
import { translate } from '../i18n/mobile-i18n'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import type { RpcFailure } from '../transport/types'
import { isMarkdownPath } from './file-tree'
import { isTerminalArtifactGrantError } from './terminal-artifact-grant-error'

export type MobileFilePreviewTextKind = 'html' | 'markdown' | 'text'

export type MobileFilePreviewResult =
  | { status: 'ready'; kind: 'media'; media: MobileFileMedia }
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

export function normalizeMobileFilePreviewResult(
  relativePath: string,
  result: unknown
): MobileFilePreviewResult {
  if (classifyMobileArtifact(relativePath) === 'image') {
    return normalizeImagePreviewResult(result)
  }
  return normalizeTextPreviewResult(relativePath, result)
}

// Keep the refusal code because it supplies fallback display copy.
export function previewErrorFromRefusal(error: RpcFailure['error']): MobileFilePreviewResult {
  return previewError(error.message || error.code)
}

export function terminalArtifactPreviewChangedError(): MobileFilePreviewResult {
  return {
    status: 'error',
    message: translate(
      'files.filePreviewResponse.fileChanged',
      'File changed on desktop. Reload preview before saving'
    ),
    reconnect: false
  }
}

export function previewError(message: string): MobileFilePreviewResult {
  const normalized = message.toLowerCase()
  if (normalized === 'binary_file' || normalized.includes('binary_file')) {
    return {
      status: 'error',
      message: translate(
        'files.filePreviewResponse.binaryUnavailable',
        'Binary preview unavailable'
      ),
      reconnect: false
    }
  }
  if (normalized === 'file_too_large' || normalized.includes('file_too_large')) {
    return {
      status: 'error',
      message: translate(
        'files.filePreviewResponse.fileTooLarge',
        'File too large for mobile preview'
      ),
      reconnect: false
    }
  }
  if (isTerminalArtifactGrantError(normalized)) {
    return {
      status: 'error',
      message: translate(
        'files.filePreviewResponse.reloadBeforeSaving',
        'Reload preview before saving'
      ),
      reconnect: false
    }
  }
  if (
    normalized.includes('remote connection dropped') ||
    normalized.includes('provider unavailable') ||
    normalized.includes('disconnected') ||
    normalized.includes('reconnect the ssh target')
  ) {
    return {
      status: 'error',
      message: translate(
        'files.filePreviewResponse.filesystemUnreachable',
        'Unable to reach the desktop filesystem'
      ),
      reconnect: true
    }
  }
  if (
    normalized.includes('enoent') ||
    normalized.includes('no such file') ||
    normalized.includes('not found') ||
    normalized.includes('does not exist')
  ) {
    return {
      status: 'error',
      message: translate('files.filePreviewResponse.fileNotFound', 'File not found'),
      reconnect: false
    }
  }
  return {
    status: 'error',
    message: translate('files.filePreviewResponse.loadFailed', 'Unable to load preview'),
    reconnect: false
  }
}

export function formatPreviewByteLength(byteLength: number): string {
  if (!Number.isFinite(byteLength) || byteLength < 0) {
    return translate('files.filePreviewResponse.unknownSize', 'unknown size')
  }
  if (byteLength < 1024) {
    return translate('files.filePreviewResponse.bytes', '{{size}} B', {
      size: byteLength.toLocaleString(getUiIntlLocale(), { useGrouping: false })
    })
  }
  if (byteLength < 1024 * 1024) {
    return translate('files.filePreviewResponse.kilobytes', '{{size}} KB', {
      size: Math.round(byteLength / 1024).toLocaleString(getUiIntlLocale(), { useGrouping: false })
    })
  }
  return translate('files.filePreviewResponse.megabytes', '{{size}} MB', {
    size: (byteLength / (1024 * 1024)).toLocaleString(getUiIntlLocale(), {
      useGrouping: false,
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    })
  })
}

function normalizeImagePreviewResult(result: unknown): MobileFilePreviewResult {
  if (!result || typeof result !== 'object') {
    return previewError('binary_file')
  }
  const preview = result as {
    content?: unknown
    isBinary?: unknown
    isImage?: unknown
    mimeType?: unknown
  }
  if (
    preview.isBinary !== true ||
    preview.isImage !== true ||
    typeof preview.mimeType !== 'string' ||
    preview.mimeType.length === 0 ||
    typeof preview.content !== 'string' ||
    preview.content.length === 0
  ) {
    return previewError('binary_file')
  }
  return {
    status: 'ready',
    kind: 'image',
    dataUri: `data:${preview.mimeType};base64,${preview.content}`
  }
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
