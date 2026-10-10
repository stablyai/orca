import { basename } from 'node:path'
import { realpath } from 'node:fs/promises'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { Store } from '../persistence'
import type {
  ChatAddressPreviewRequest,
  ChatAddressPreviewResult
} from '../../shared/chat-address-preview'
import { isTrustedBrowserRenderer } from '../ipc/browser-renderer-trust'
import { resolveLocalFileRequestPath } from '../ipc/local-file-access-resolution'
import {
  openLocalRegularFile,
  readLocalFileBounded,
  readLocalFilePrefix
} from '../ipc/filesystem/local-regular-file-read'
import { assertRasterImagePreviewWithinLimits } from '../../shared/raster-image-preview-limits'
import {
  CHAT_PREVIEW_MAX_SOURCE_LENGTH,
  PrivatePreviewAddressError,
  assertPreviewLocalPath,
  isValidPreviewId,
  parsePreviewLocalPath,
  resolvePreviewLocalSymlinks,
  parsePreviewNetworkUrl
} from './chat-address-preview-security'
import {
  CHAT_ADDRESS_PREVIEW_SCHEME,
  createChatPreviewGrant,
  releaseChatPreviewGrant,
  releaseOwnedChatPreview,
  type ChatPreviewGrant
} from './chat-address-preview-grants'
import {
  CHAT_PREVIEW_PROBE_BYTES,
  inspectPreviewContent,
  previewContentLimit,
  type PreviewContentType
} from './chat-address-preview-content'
import {
  CHAT_PREVIEW_MAX_MEDIA_BYTES,
  openPreviewNetworkResponse,
  previewResponseSize,
  readPreviewNetworkBytes
} from './chat-address-preview-network'

type ReadyPreview = Extract<ChatAddressPreviewResult, { status: 'ready' }>

function readyPreview(
  grant: ChatPreviewGrant,
  name: string,
  type: PreviewContentType,
  size: number | undefined,
  bytes?: Buffer
): ReadyPreview {
  grant.controller.signal.throwIfAborted()
  grant.mimeType = type.mimeType
  const result: ReadyPreview = { status: 'ready', id: grant.id, name, ...type, size }
  if (type.kind === 'image' && bytes) {
    assertRasterImagePreviewWithinLimits(bytes, type.mimeType)
    grant.resource = { type: 'bytes', bytes }
  }
  if (['image', 'audio', 'video'].includes(type.kind)) {
    result.url = `${CHAT_ADDRESS_PREVIEW_SCHEME}://resource/${grant.token}`
  } else if (bytes && type.kind === 'pdf') {
    result.content = bytes.toString('base64')
  } else if (bytes && (type.kind === 'text' || type.kind === 'markdown')) {
    result.content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  return result
}

async function loadLocalPreview(
  grant: ChatPreviewGrant,
  source: string,
  store: Store
): Promise<ReadyPreview> {
  const requested = await resolvePreviewLocalSymlinks(
    parsePreviewLocalPath(source),
    grant.controller.signal
  )
  const authorized = await resolveLocalFileRequestPath(requested, { kind: 'user-file' }, store)
  grant.controller.signal.throwIfAborted()
  const filePath = await realpath(authorized)
  assertPreviewLocalPath(filePath)
  grant.controller.signal.throwIfAborted()
  const { handle, stats } = await openLocalRegularFile(filePath)
  let retained = false
  try {
    grant.controller.signal.throwIfAborted()
    grant.resource = { type: 'local', handle, size: stats.size }
    const prefix = await readLocalFilePrefix(handle, CHAT_PREVIEW_PROBE_BYTES)
    const name = basename(filePath)
    const type = inspectPreviewContent(prefix, name)
    if (type.kind === 'audio' || type.kind === 'video') {
      const result = readyPreview(grant, name, type, stats.size)
      retained = true
      return result
    }
    if (type.kind === 'file') {
      return readyPreview(grant, name, type, stats.size)
    }
    const limit = previewContentLimit(type.kind)
    if (stats.size > limit) {
      throw new Error('Preview file exceeds the size limit')
    }
    const bytes = await readLocalFileBounded(handle, limit, stats.size)
    return readyPreview(grant, name, type, bytes.length, bytes)
  } finally {
    if (!retained) {
      if (grant.resource?.type === 'local') {
        grant.resource = undefined
      }
      await handle.close().catch(() => {})
    }
  }
}

async function loadNetworkPreview(
  grant: ChatPreviewGrant,
  request: ChatAddressPreviewRequest
): Promise<ReadyPreview> {
  const source = parsePreviewNetworkUrl(request.source)
  const options = {
    signal: grant.controller.signal,
    allowPrivateNetwork: request.allowPrivateNetwork === true,
    budget: grant.budget
  }
  const probe = await openPreviewNetworkResponse(source, {
    ...options,
    range: `bytes=0-${CHAT_PREVIEW_PROBE_BYTES - 1}`
  })
  if (
    probe.response.statusCode === 206 &&
    !/^bytes 0-\d+\/(?:\d+|\*)$/.test(probe.response.headers['content-range'] ?? '')
  ) {
    probe.close()
    throw new Error('Preview server returned an invalid content range')
  }
  const size = previewResponseSize(probe.response)
  const mime = probe.response.headers['content-type']
  const finalUrl = probe.url
  let name: string
  try {
    name = decodeURIComponent(finalUrl.pathname.split('/').pop() || finalUrl.hostname)
  } catch {
    name = finalUrl.hostname
  }
  name = name.replace(/\p{Cc}/gu, '').slice(0, 255) || 'Preview'
  const prefix = await readPreviewNetworkBytes(probe, CHAT_PREVIEW_PROBE_BYTES, true)
  const type = inspectPreviewContent(prefix, name, mime)
  grant.controller.signal.throwIfAborted()
  if (type.kind === 'audio' || type.kind === 'video') {
    if (size !== undefined && size > CHAT_PREVIEW_MAX_MEDIA_BYTES) {
      throw new Error('Preview file exceeds the size limit')
    }
    grant.resource = {
      type: 'network',
      url: finalUrl,
      size,
      allowPrivateNetwork: options.allowPrivateNetwork
    }
    return readyPreview(grant, name, type, size)
  }
  if (type.kind === 'file') {
    return readyPreview(grant, name, type, size)
  }
  const limit = previewContentLimit(type.kind)
  if (size !== undefined && size > limit) {
    throw new Error('Preview file exceeds the size limit')
  }
  const body = await openPreviewNetworkResponse(finalUrl, options)
  if (body.response.statusCode !== 200) {
    body.close()
    throw new Error('Preview server returned an incomplete document')
  }
  const bytes = await readPreviewNetworkBytes(body, limit)
  const actualType = inspectPreviewContent(
    bytes.subarray(0, CHAT_PREVIEW_PROBE_BYTES),
    name,
    body.response.headers['content-type']
  )
  if (actualType.kind !== type.kind || actualType.mimeType !== type.mimeType) {
    throw new Error('Preview content changed during the read')
  }
  return readyPreview(grant, name, type, bytes.length, bytes)
}

export async function previewChatAddress(
  event: IpcMainInvokeEvent,
  value: unknown,
  store: Store
): Promise<ChatAddressPreviewResult> {
  const request = value as Partial<ChatAddressPreviewRequest> | null
  const id = isValidPreviewId(request?.id) ? request.id : ''
  let grant: ChatPreviewGrant | undefined
  try {
    if (!isTrustedBrowserRenderer(event.sender) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Untrusted address preview request')
    }
    if (
      !id ||
      typeof request?.source !== 'string' ||
      !request.source.length ||
      request.source.length > CHAT_PREVIEW_MAX_SOURCE_LENGTH ||
      (request.allowPrivateNetwork !== undefined &&
        typeof request.allowPrivateNetwork !== 'boolean')
    ) {
      throw new Error('Invalid address preview request')
    }
    grant = createChatPreviewGrant(event.sender, id)
    const input = { id, source: request.source, allowPrivateNetwork: request.allowPrivateNetwork }
    return /^https?:/i.test(input.source)
      ? await loadNetworkPreview(grant, input)
      : await loadLocalPreview(grant, input.source, store)
  } catch (error) {
    if (grant) {
      releaseChatPreviewGrant(grant)
    }
    return {
      status: error instanceof PrivatePreviewAddressError ? 'permission-required' : 'error',
      id,
      message: error instanceof Error ? error.message : 'Address preview failed'
    }
  }
}

export function registerChatAddressPreviewHandlers(store: Store): void {
  ipcMain.handle('fs:previewAddress', (event, request: unknown) =>
    previewChatAddress(event, request, store)
  )
  ipcMain.handle('fs:releaseAddressPreview', (event, request: unknown) => {
    if (!isTrustedBrowserRenderer(event.sender) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Untrusted address preview release')
    }
    const id = (request as { id?: unknown } | null)?.id
    if (!isValidPreviewId(id)) {
      throw new Error('Invalid address preview ID')
    }
    releaseOwnedChatPreview(event.sender.id, id)
  })
}
