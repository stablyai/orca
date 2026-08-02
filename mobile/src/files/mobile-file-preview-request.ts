import { classifyMobileArtifact } from '../session/mobile-artifact-kind'
import type { RpcFailure, RpcResponse } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import {
  normalizeMobileFilePreviewResponse,
  previewError,
  type MobileFilePreviewResult
} from './mobile-file-preview-response'
import {
  refreshTerminalArtifactSourceAfterGrantFailure,
  type MobileTerminalArtifactPreviewSource,
  type TerminalArtifactRetryOptions
} from './mobile-terminal-artifact-grant-refresh'

export {
  formatPreviewByteLength,
  normalizeMobileFilePreviewResponse,
  previewError
} from './mobile-file-preview-response'
export type {
  MobileFilePreviewResult,
  MobileFilePreviewTextKind
} from './mobile-file-preview-response'

export type MobileFilePreviewReadMethod = 'files.read' | 'files.readPreview'
export type MobileTerminalArtifactPreviewReadMethod =
  | 'files.readTerminalArtifact'
  | 'files.readTerminalArtifactPreview'

export type MobileFilePreviewSource =
  | {
      source: 'worktree'
      worktreeId: string
      relativePath: string
    }
  | MobileTerminalArtifactPreviewSource

export type MobileFilePreviewRequest = {
  method: MobileFilePreviewReadMethod | MobileTerminalArtifactPreviewReadMethod
  params: {
    worktree: string
    relativePath?: string
    absolutePath?: string
    grantId?: string
  }
}

type MobileFilePreviewClient = Pick<RpcClient, 'sendRequest'>
type TerminalArtifactSource = MobileTerminalArtifactPreviewSource
type TerminalArtifactSaveOptions = TerminalArtifactRetryOptions & {
  baseContent?: string
}

export function createMobileFilePreviewRequest(
  worktreeIdOrSource: string | MobileFilePreviewSource,
  relativePath?: string
): MobileFilePreviewRequest {
  const source =
    typeof worktreeIdOrSource === 'string'
      ? { source: 'worktree' as const, worktreeId: worktreeIdOrSource, relativePath: relativePath! }
      : worktreeIdOrSource
  if (source.source === 'terminalArtifact') {
    const method =
      classifyMobileArtifact(source.absolutePath) === 'image'
        ? 'files.readTerminalArtifactPreview'
        : 'files.readTerminalArtifact'
    return {
      method,
      params: {
        worktree: `id:${source.worktreeId}`,
        absolutePath: source.absolutePath,
        grantId: source.grantId
      }
    }
  }
  return {
    method:
      classifyMobileArtifact(source.relativePath) === 'image' ? 'files.readPreview' : 'files.read',
    params: {
      worktree: `id:${source.worktreeId}`,
      relativePath: source.relativePath
    }
  }
}

export async function loadMobileFilePreview(
  client: MobileFilePreviewClient,
  worktreeIdOrSource: string | MobileFilePreviewSource,
  relativePath?: string,
  options: TerminalArtifactRetryOptions = {}
): Promise<MobileFilePreviewResult> {
  let source = worktreeIdOrSource
  let request = createMobileFilePreviewRequest(source, relativePath)
  let response = await client.sendRequest(request.method, request.params)
  if (!response.ok && typeof source !== 'string' && source.source === 'terminalArtifact') {
    const refreshed = await refreshTerminalArtifactSourceAfterGrantFailure(
      client,
      source,
      response,
      options
    )
    if (refreshed) {
      source = refreshed
      options.onTerminalArtifactSourceRefreshed?.(refreshed)
      request = createMobileFilePreviewRequest(source, relativePath)
      response = await client.sendRequest(request.method, request.params)
    }
  }
  const previewPath = typeof source === 'string' ? relativePath! : previewPathForSource(source)
  return normalizeMobileFilePreviewResponse(previewPath, response)
}

export async function saveMobileTerminalArtifactPreview(
  client: MobileFilePreviewClient,
  source: TerminalArtifactSource,
  content: string,
  options: TerminalArtifactSaveOptions = {}
): Promise<MobileFilePreviewResult | { status: 'saved' }> {
  let writeSource = source
  if (typeof options.baseContent === 'string') {
    const verified = await verifyTerminalArtifactBaseContent(
      client,
      writeSource,
      options.baseContent,
      options
    )
    if (verified.status === 'error') {
      return verified.error
    }
    writeSource = verified.source
    if (verified.refreshed) {
      options.onTerminalArtifactSourceRefreshed?.(verified.source)
    }
  }
  let response = await writeTerminalArtifactPreview(client, writeSource, content)
  if (response.ok) {
    return { status: 'saved' }
  }

  if (typeof options.baseContent !== 'string') {
    return previewError(
      (response as RpcFailure).error.message || (response as RpcFailure).error.code
    )
  }
  const refreshed = await refreshTerminalArtifactSourceAfterGrantFailure(
    client,
    writeSource,
    response,
    options
  )
  if (!refreshed) {
    return previewError(
      (response as RpcFailure).error.message || (response as RpcFailure).error.code
    )
  }
  const verified = await verifyTerminalArtifactBaseContent(client, refreshed, options.baseContent, {
    refreshGrant: false
  })
  if (verified.status === 'error') {
    return verified.error
  }
  options.onTerminalArtifactSourceRefreshed?.(refreshed)
  writeSource = verified.source
  response = await writeTerminalArtifactPreview(client, writeSource, content)
  if (!response.ok) {
    return previewError(
      (response as RpcFailure).error.message || (response as RpcFailure).error.code
    )
  }
  return { status: 'saved' }
}

async function verifyTerminalArtifactBaseContent(
  client: MobileFilePreviewClient,
  source: TerminalArtifactSource,
  baseContent: string,
  options: TerminalArtifactRetryOptions
): Promise<
  | { status: 'ok'; source: TerminalArtifactSource; refreshed: boolean }
  | { status: 'error'; error: MobileFilePreviewResult }
> {
  let readSource = source
  let request = createMobileFilePreviewRequest(readSource)
  let response = await client.sendRequest(request.method, request.params)
  let refreshed = false
  if (!response.ok) {
    const nextSource = await refreshTerminalArtifactSourceAfterGrantFailure(
      client,
      readSource,
      response,
      options
    )
    if (!nextSource) {
      return {
        status: 'error',
        error: previewError(
          (response as RpcFailure).error.message || (response as RpcFailure).error.code
        )
      }
    }
    readSource = nextSource
    refreshed = true
    request = createMobileFilePreviewRequest(readSource)
    response = await client.sendRequest(request.method, request.params)
  }
  if (!response.ok) {
    return {
      status: 'error',
      error: previewError(
        (response as RpcFailure).error.message || (response as RpcFailure).error.code
      )
    }
  }
  const latest = normalizeMobileFilePreviewResponse(readSource.absolutePath, response)
  if (latest.status === 'error' || latest.status === 'waiting') {
    return { status: 'error', error: latest }
  }
  if (!terminalArtifactPreviewMatchesBase(latest, baseContent)) {
    return {
      status: 'error',
      error: {
        status: 'error',
        message: 'File changed on desktop. Reload preview before saving',
        reconnect: false
      }
    }
  }
  return { status: 'ok', source: readSource, refreshed }
}

function writeTerminalArtifactPreview(
  client: MobileFilePreviewClient,
  source: TerminalArtifactSource,
  content: string
): Promise<RpcResponse> {
  return client.sendRequest('files.writeTerminalArtifact', {
    worktree: `id:${source.worktreeId}`,
    absolutePath: source.absolutePath,
    grantId: source.grantId,
    content
  })
}

function terminalArtifactPreviewMatchesBase(
  preview: MobileFilePreviewResult,
  baseContent: string
): boolean {
  if (preview.status === 'empty') {
    return baseContent.length === 0
  }
  return preview.status === 'ready' && preview.kind !== 'image' && preview.content === baseContent
}

function previewPathForSource(source: MobileFilePreviewSource): string {
  return source.source === 'terminalArtifact' ? source.absolutePath : source.relativePath
}
