import { classifyMobileArtifact } from '../session/mobile-artifact-kind'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { isMarkdownPath } from './file-tree'

export type MobileFilePreviewReadMethod = 'files.read' | 'files.readPreview'

export type MobileFilePreviewRequest = {
  method: MobileFilePreviewReadMethod
  params: {
    worktree: string
    relativePath: string
  }
}

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

type MobileFilePreviewClient = Pick<RpcClient, 'sendRequest'>

export function createMobileFilePreviewRequest(
  worktreeId: string,
  relativePath: string
): MobileFilePreviewRequest {
  return {
    method: classifyMobileArtifact(relativePath) === 'image' ? 'files.readPreview' : 'files.read',
    params: {
      worktree: `id:${worktreeId}`,
      relativePath
    }
  }
}

export async function loadMobileFilePreview(
  client: MobileFilePreviewClient,
  worktreeId: string,
  relativePath: string
): Promise<MobileFilePreviewResult> {
  const request = createMobileFilePreviewRequest(worktreeId, relativePath)
  const response = await client.sendRequest(request.method, request.params)
  return normalizeMobileFilePreviewResponse(relativePath, response)
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
  if (classifyMobileArtifact(relativePath) === 'image') {
    return normalizeImagePreviewResult(result)
  }
  return normalizeTextPreviewResult(relativePath, result)
}

export function previewError(message: string): MobileFilePreviewResult {
  const normalized = message.toLowerCase()
  if (normalized === 'binary_file' || normalized.includes('binary_file')) {
    return { status: 'error', message: 'Binary preview unavailable', reconnect: false }
  }
  if (normalized === 'file_too_large' || normalized.includes('file_too_large')) {
    return { status: 'error', message: 'File too large for mobile preview', reconnect: false }
  }
  if (
    normalized.includes('remote connection dropped') ||
    normalized.includes('provider unavailable') ||
    normalized.includes('disconnected')
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
