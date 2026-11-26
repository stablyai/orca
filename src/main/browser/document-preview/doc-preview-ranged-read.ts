import { MEDIA_FILE_MIME_TYPES } from '../../../shared/file-preview/media-mime-types'
import {
  DOC_PREVIEW_FILE_CHANGED_MESSAGE,
  type DocPreviewFileChunk
} from '../../../shared/document-preview/doc-preview-file-access'
import { callRuntimeEnvironment } from '../../ipc/runtime-environments/requests/runtime-environment-transport-routing'
import { getRuntimeEnvironmentRegistryRoot } from '../../ipc/runtime-environments/catalog/runtime-environment-registry-root'
import {
  assertRemoteChunkReadsSupported,
  readRemotePreviewChunk,
  statRemotePreviewFile,
  type GrantedRemoteFilePreviewAddress
} from '../../media/remote-file-preview-reader'
import { getDocPreviewGrant, type DocPreviewGrant } from './doc-preview-grant-registry'
import type { RuntimeDocPreviewReadParams } from './doc-preview-runtime-read-contract'

const DOC_PREVIEW_CHUNK_TIMEOUT_MS = 15_000
const MEDIA_MIME_TYPES = new Set(Object.values(MEDIA_FILE_MIME_TYPES))

export const RUNTIME_TOO_LARGE_ERROR = 'file_too_large'

/** The range a media response reads first, and its request's cancellation. */
export type DocPreviewMediaRequest = {
  firstRead: { offset: number; length: number }
  signal: AbortSignal
}

/** Reads stop when the request is cancelled or the response closes. */
function mediaReadLifetime(request: DocPreviewMediaRequest): {
  signal: AbortSignal
  close: () => Promise<void>
} {
  const controller = new AbortController()
  return {
    signal: AbortSignal.any([controller.signal, request.signal]),
    close: async () => controller.abort()
  }
}

/** Byte-range access to one preview file, the shape `createMediaRangeResponse` streams. */
export type DocPreviewMediaSource = {
  size: number
  read: (offset: number, length: number) => Promise<Uint8Array>
  close: () => Promise<void>
}

function isDocPreviewFileChunk(value: unknown): value is DocPreviewFileChunk {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const chunk: Partial<Record<keyof DocPreviewFileChunk, unknown>> = value
  return (
    typeof chunk.contentBase64 === 'string' &&
    Number.isSafeInteger(chunk.size) &&
    typeof chunk.mtimeMs === 'number' &&
    typeof chunk.ctimeMs === 'number' &&
    (chunk.mimeType === undefined || typeof chunk.mimeType === 'string')
  )
}

/** One range of a workspace preview file; the host re-authorizes the path on every call. */
export async function readRuntimeDocPreviewChunk(
  environmentId: string,
  params: RuntimeDocPreviewReadParams,
  offset: number,
  length: number,
  options: { media?: boolean; signal?: AbortSignal } = {}
): Promise<DocPreviewFileChunk> {
  const response = await callRuntimeEnvironment(
    getRuntimeEnvironmentRegistryRoot(),
    environmentId,
    'files.readDocPreviewChunk',
    { ...params, offset, length, ...(options.media ? { media: true } : {}) },
    DOC_PREVIEW_CHUNK_TIMEOUT_MS,
    undefined,
    undefined,
    // Reading the preview the user opened may wake an idle-stopped WSL host (#46567).
    { wake: true, ...(options.signal ? { signal: options.signal } : {}) }
  )
  if (!response.ok) {
    // Hosts before ranged preview reads keep the one-reply size refusal.
    throw new Error(
      response.error.code === 'method_not_found' ? RUNTIME_TOO_LARGE_ERROR : response.error.message
    )
  }
  if (!isDocPreviewFileChunk(response.result)) {
    throw new Error('The paired machine returned an unreadable file chunk.')
  }
  return response.result
}

function assertGrantLive(grant: DocPreviewGrant): void {
  // Why: a closed preview revokes its grant; stop reading a file nobody will see.
  if (!getDocPreviewGrant(grant.id)) {
    throw new Error('Not found')
  }
}

/**
 * A workspace audio/video file read by range, pinned to the version of its first chunk.
 * Null when the host doesn't name it as media (hosts before media previews send it as text).
 */
export async function openWorkspaceDocPreviewMedia(
  grant: DocPreviewGrant,
  environmentId: string,
  params: RuntimeDocPreviewReadParams,
  request: DocPreviewMediaRequest
): Promise<DocPreviewMediaSource | null> {
  const { firstRead } = request
  const lifetime = mediaReadLifetime(request)
  const read = (offset: number, length: number): Promise<DocPreviewFileChunk> =>
    readRuntimeDocPreviewChunk(environmentId, params, offset, length, {
      media: true,
      signal: lifetime.signal
    })
  // Why: the first chunk carries size and type, so the response's first page costs no extra round trip.
  const first = await read(firstRead.offset, firstRead.length)
  // Why: the host classifies the opened target, so a media-named link to another type isn't streamed.
  if (!first.mimeType || !MEDIA_MIME_TYPES.has(first.mimeType)) {
    return null
  }
  let prefetched: { offset: number; bytes: Buffer } | null = {
    offset: firstRead.offset,
    bytes: Buffer.from(first.contentBase64, 'base64')
  }
  return {
    size: first.size,
    read: async (offset, length) => {
      assertGrantLive(grant)
      const page = prefetched
      prefetched = null
      if (page && page.offset === offset && page.bytes.length > 0) {
        return page.bytes.subarray(0, length)
      }
      const chunk = await read(offset, length)
      if (
        chunk.size !== first.size ||
        chunk.mtimeMs !== first.mtimeMs ||
        chunk.ctimeMs !== first.ctimeMs
      ) {
        throw new Error(DOC_PREVIEW_FILE_CHANGED_MESSAGE)
      }
      return Buffer.from(chunk.contentBase64, 'base64')
    },
    close: lifetime.close
  }
}

/** An audio/video file outside every workspace, read by range under the host's file grant. */
export async function openGrantedDocPreviewMedia(
  grant: DocPreviewGrant,
  address: GrantedRemoteFilePreviewAddress,
  request: DocPreviewMediaRequest
): Promise<DocPreviewMediaSource> {
  const { signal, close } = mediaReadLifetime(request)
  const { size } = await statRemotePreviewFile(address, signal)
  // Why: hosts that stat granted files can still lack their range reads; fail here, not mid-body.
  if (size > 0) {
    await assertRemoteChunkReadsSupported(address, signal)
  }
  return {
    size,
    read: async (offset, length) => {
      assertGrantLive(grant)
      return readRemotePreviewChunk(address, offset, length, signal)
    },
    close
  }
}
