import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-content/file-range-read'
import type { RemoteFilePreviewAddress } from '../../shared/file-preview/remote-file-preview-address'
import { remoteFileRequest } from '../../shared/file-access/remote-file-locator'
import { isRenewableTerminalFileGrantRefusal } from '../../shared/file-access/terminal-file-grant-refusal'
import type { RuntimeFileReadChunkResult } from '../../shared/file-content/runtime-file-read'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { getRuntimeEnvironmentRegistryRoot } from '../ipc/runtime-environments/runtime-environment-registry-root'

const STAT_TIMEOUT_MS = 15_000
// Why: previews share a two-call lane; a stalled chunk must free it well before a download's minute.
const READ_CHUNK_TIMEOUT_MS = 20_000

export const REMOTE_PREVIEW_UPDATE_REQUIRED_MESSAGE =
  'Previewing this file requires a newer Orca on the paired machine. Update it and try again.'

/** The pairing that minted a grant is gone; the grant can never answer again. */
export class RemotePreviewPairingChangedError extends Error {}

/** The host refused a granted file's grant as lapsed; a fresh grant for its path can still read it. */
export class RemotePreviewGrantLapsedError extends Error {}

export type GrantedRemoteFilePreviewAddress = Extract<RemoteFilePreviewAddress, { grantId: string }>

export type RemotePreviewFileSnapshot = { size: number; mtime: number; ctime?: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function callRemote(
  address: RemoteFilePreviewAddress,
  operation: 'stat' | 'readChunk',
  range: { offset: number; length: number } | null,
  timeoutMs: number,
  signal: AbortSignal
): Promise<unknown> {
  const { method, params } = remoteFileRequest(address.worktree, address, operation)
  const response = await callRuntimeEnvironment(
    // The registry the pairing IPC writes; the canonical path can differ in casing.
    getRuntimeEnvironmentRegistryRoot(),
    address.environmentId,
    method,
    { ...params, ...range },
    timeoutMs,
    address.expectedEnvironmentPairingRevision,
    undefined,
    { signal }
  )
  if (!response.ok) {
    if (response.error.code === 'runtime_environment_changed') {
      throw new RemotePreviewPairingChangedError(response.error.message)
    }
    if (isRenewableTerminalFileGrantRefusal(response.error.message)) {
      throw new RemotePreviewGrantLapsedError(response.error.message)
    }
    // Why: a host without these stat/readChunk methods can only be updated, never retried.
    throw new Error(
      response.error.code === 'method_not_found'
        ? REMOTE_PREVIEW_UPDATE_REQUIRED_MESSAGE
        : response.error.message
    )
  }
  return response.result
}

export async function statRemotePreviewFile(
  address: RemoteFilePreviewAddress,
  signal: AbortSignal
): Promise<RemotePreviewFileSnapshot> {
  const result = await callRemote(address, 'stat', null, STAT_TIMEOUT_MS, signal)
  if (
    !isRecord(result) ||
    typeof result.size !== 'number' ||
    !Number.isSafeInteger(result.size) ||
    result.size < 0 ||
    typeof result.isDirectory !== 'boolean' ||
    typeof result.mtime !== 'number'
  ) {
    throw new Error('The paired machine returned an unreadable file description.')
  }
  if (result.isDirectory) {
    throw new Error('This path is a directory, not a file.')
  }
  return {
    size: result.size,
    mtime: result.mtime,
    ...(typeof result.ctime === 'number' ? { ctime: result.ctime } : {})
  }
}

function isReadChunkResult(value: unknown): value is RuntimeFileReadChunkResult {
  return (
    isRecord(value) &&
    typeof value.contentBase64 === 'string' &&
    typeof value.bytesRead === 'number' &&
    typeof value.eof === 'boolean'
  )
}

export async function readRemotePreviewChunk(
  address: RemoteFilePreviewAddress,
  offset: number,
  length: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  const result = await callRemote(
    address,
    'readChunk',
    { offset, length },
    READ_CHUNK_TIMEOUT_MS,
    signal
  )
  if (!isReadChunkResult(result)) {
    throw new Error('The paired machine returned an unreadable file chunk.')
  }
  const bytes = new Uint8Array(Buffer.from(result.contentBase64, 'base64'))
  if (bytes.length !== result.bytesRead || bytes.length > length) {
    throw new Error('The paired machine returned a corrupted file chunk.')
  }
  return bytes
}

const MAX_CHUNK_READ_VERDICTS = 64
const chunkReadVerdicts = new Set<string>()

/**
 * Hosts from v1.4.5 answer files.stat but only v1.4.111 and later answer files.readChunk, and no
 * capability names it, so one byte proves it; cached per pairing, since a re-pair can change hosts.
 */
export async function assertRemoteChunkReadsSupported(
  address: RemoteFilePreviewAddress,
  signal: AbortSignal
): Promise<void> {
  const revision = address.expectedEnvironmentPairingRevision
  // Why the kind: granted files page through their own method, which a host can lack.
  const key = JSON.stringify([address.environmentId, revision, address.grantId !== undefined])
  if (revision !== undefined && chunkReadVerdicts.has(key)) {
    return
  }
  await readRemotePreviewChunk(address, 0, 1, signal)
  // Why: an unpinned verdict would outlive a re-pair under the same environment id.
  if (revision === undefined) {
    return
  }
  if (chunkReadVerdicts.size >= MAX_CHUNK_READ_VERDICTS) {
    const oldest = chunkReadVerdicts.values().next().value
    if (oldest !== undefined) {
      chunkReadVerdicts.delete(oldest)
    }
  }
  chunkReadVerdicts.add(key)
}

/** `length` bytes from `offset` (clipped to `size`), in chunks the host accepts; fewer at EOF. */
export async function readRemotePreviewRange(
  address: RemoteFilePreviewAddress,
  offset: number,
  length: number,
  size: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  const end = Math.min(offset + length, size)
  const range = new Uint8Array(Math.max(0, end - offset))
  let read = 0
  while (offset + read < end) {
    const chunk = await readRemotePreviewChunk(
      address,
      offset + read,
      Math.min(MAX_FILE_RANGE_READ_BYTES, end - offset - read),
      signal
    )
    if (chunk.byteLength === 0) {
      break
    }
    range.set(chunk, read)
    read += chunk.byteLength
  }
  return range.subarray(0, read)
}

/** A fresh grant for a previewed host file, as the editor renews one; refused when the host binds the path elsewhere. */
export async function renewRemotePreviewGrant(
  address: GrantedRemoteFilePreviewAddress,
  signal: AbortSignal
): Promise<GrantedRemoteFilePreviewAddress> {
  const response = await callRuntimeEnvironment(
    getRuntimeEnvironmentRegistryRoot(),
    address.environmentId,
    'files.resolveTerminalPath',
    { worktree: address.worktree, pathText: address.absolutePath },
    STAT_TIMEOUT_MS,
    address.expectedEnvironmentPairingRevision,
    undefined,
    { signal }
  )
  if (!response.ok && response.error.code === 'runtime_environment_changed') {
    throw new RemotePreviewPairingChangedError(response.error.message)
  }
  const openTarget =
    response.ok && isRecord(response.result) && isRecord(response.result.openTarget)
      ? response.result.openTarget
      : null
  if (
    openTarget?.kind !== 'absolute-file' ||
    openTarget.absolutePath !== address.absolutePath ||
    typeof openTarget.grantId !== 'string' ||
    !openTarget.grantId
  ) {
    throw new Error(`The host no longer grants ${address.absolutePath}`)
  }
  return { ...address, grantId: openTarget.grantId }
}
