import { classifyMobileArtifact } from '../session/mobile-artifact-kind'
import type { RpcAcceptedResult } from '../transport/rpc-accepted-result'
import type { RpcFailure, RpcResponse } from '../transport/types'
import {
  filePreviewImageRead,
  filePreviewTextRead,
  terminalArtifactImageRead,
  terminalArtifactTextRead,
  terminalArtifactWrite,
  type MobileFilePreviewRpcSender
} from './mobile-file-preview-operations'
import {
  normalizeMobileFilePreviewResult,
  previewError,
  previewErrorFromRefusal,
  type MobileFilePreviewResult
} from './mobile-file-preview-response'
import {
  refreshTerminalArtifactSourceAfterGrantFailure,
  type MobileTerminalArtifactPreviewSource,
  type TerminalArtifactRetryOptions
} from './mobile-terminal-artifact-grant-refresh'

export { formatPreviewByteLength, previewError } from './mobile-file-preview-response'

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

/** Which read the path selects, and the params that read takes. */
export type MobileFilePreviewRequest =
  | {
      method: MobileFilePreviewReadMethod
      params: { worktree: string; relativePath: string }
    }
  | {
      method: MobileTerminalArtifactPreviewReadMethod
      params: { worktree: string; absolutePath: string; grantId: string }
    }

/**
 * A settled preview send. The refusal is carried rather than interpreted because the preview
 * screen's fallback copy is the host's `code`, which no acceptance policy exposes, and the grant
 * refresh reads the same code to decide whether a stale grant is worth re-minting.
 */
type MobileFilePreviewOutcome =
  | { accepted: true; payload: unknown }
  | { accepted: false; refusal: RpcFailure['error'] }

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

async function sendMobileFilePreviewRead(
  client: MobileFilePreviewRpcSender,
  request: MobileFilePreviewRequest
): Promise<MobileFilePreviewOutcome> {
  switch (request.method) {
    case 'files.read':
      return settlePreviewSend(
        await filePreviewTextRead.request(client, request.params),
        filePreviewTextRead.interpret
      )
    case 'files.readPreview':
      return settlePreviewSend(
        await filePreviewImageRead.request(client, request.params),
        filePreviewImageRead.interpret
      )
    case 'files.readTerminalArtifact':
      return settlePreviewSend(
        await terminalArtifactTextRead.request(client, request.params),
        terminalArtifactTextRead.interpret
      )
    case 'files.readTerminalArtifactPreview':
      return settlePreviewSend(
        await terminalArtifactImageRead.request(client, request.params),
        terminalArtifactImageRead.interpret
      )
  }
}

function settlePreviewSend(
  reply: RpcResponse,
  interpret: (reply: RpcResponse) => RpcAcceptedResult<unknown>
): MobileFilePreviewOutcome {
  const verdict = interpret(reply)
  return verdict.accepted
    ? { accepted: true, payload: verdict.value }
    : // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this policy skips only a refusal, so an unaccepted reply is a failure envelope.
      { accepted: false, refusal: (reply as RpcFailure).error }
}

export async function loadMobileFilePreview(
  client: MobileFilePreviewRpcSender,
  worktreeIdOrSource: string | MobileFilePreviewSource,
  relativePath?: string,
  options: TerminalArtifactRetryOptions = {}
): Promise<MobileFilePreviewResult> {
  let source = worktreeIdOrSource
  let read = await sendMobileFilePreviewRead(
    client,
    createMobileFilePreviewRequest(source, relativePath)
  )
  if (!read.accepted && typeof source !== 'string' && source.source === 'terminalArtifact') {
    const refreshed = await refreshTerminalArtifactSourceAfterGrantFailure(
      client,
      source,
      read.refusal,
      options
    )
    if (refreshed) {
      source = refreshed
      options.onTerminalArtifactSourceRefreshed?.(refreshed)
      read = await sendMobileFilePreviewRead(
        client,
        createMobileFilePreviewRequest(source, relativePath)
      )
    }
  }
  const previewPath = typeof source === 'string' ? relativePath! : previewPathForSource(source)
  return read.accepted
    ? normalizeMobileFilePreviewResult(previewPath, read.payload)
    : previewErrorFromRefusal(read.refusal)
}

export async function saveMobileTerminalArtifactPreview(
  client: MobileFilePreviewRpcSender,
  source: TerminalArtifactSource,
  content: string,
  options: TerminalArtifactSaveOptions = {}
): Promise<MobileFilePreviewResult | { status: 'saved' }> {
  if (source.readOnly) {
    return previewError('This file is read-only')
  }
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
  let write = await writeTerminalArtifactPreview(client, writeSource, content)
  if (write.accepted) {
    return { status: 'saved' }
  }

  if (typeof options.baseContent !== 'string') {
    return previewErrorFromRefusal(write.refusal)
  }
  const refreshed = await refreshTerminalArtifactSourceAfterGrantFailure(
    client,
    writeSource,
    write.refusal,
    options
  )
  if (!refreshed) {
    return previewErrorFromRefusal(write.refusal)
  }
  const verified = await verifyTerminalArtifactBaseContent(client, refreshed, options.baseContent, {
    refreshGrant: false
  })
  if (verified.status === 'error') {
    return verified.error
  }
  options.onTerminalArtifactSourceRefreshed?.(refreshed)
  writeSource = verified.source
  write = await writeTerminalArtifactPreview(client, writeSource, content)
  if (!write.accepted) {
    return previewErrorFromRefusal(write.refusal)
  }
  return { status: 'saved' }
}

async function verifyTerminalArtifactBaseContent(
  client: MobileFilePreviewRpcSender,
  source: TerminalArtifactSource,
  baseContent: string,
  options: TerminalArtifactRetryOptions
): Promise<
  | { status: 'ok'; source: TerminalArtifactSource; refreshed: boolean }
  | { status: 'error'; error: MobileFilePreviewResult }
> {
  let readSource = source
  let read = await sendMobileFilePreviewRead(client, createMobileFilePreviewRequest(readSource))
  let refreshed = false
  if (!read.accepted) {
    const nextSource = await refreshTerminalArtifactSourceAfterGrantFailure(
      client,
      readSource,
      read.refusal,
      options
    )
    if (!nextSource) {
      return { status: 'error', error: previewErrorFromRefusal(read.refusal) }
    }
    readSource = nextSource
    refreshed = true
    read = await sendMobileFilePreviewRead(client, createMobileFilePreviewRequest(readSource))
  }
  if (!read.accepted) {
    return { status: 'error', error: previewErrorFromRefusal(read.refusal) }
  }
  const latest = normalizeMobileFilePreviewResult(readSource.absolutePath, read.payload)
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

async function writeTerminalArtifactPreview(
  client: MobileFilePreviewRpcSender,
  source: TerminalArtifactSource,
  content: string
): Promise<MobileFilePreviewOutcome> {
  return settlePreviewSend(
    await terminalArtifactWrite.request(client, {
      worktree: `id:${source.worktreeId}`,
      absolutePath: source.absolutePath,
      grantId: source.grantId,
      content
    }),
    terminalArtifactWrite.interpret
  )
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
