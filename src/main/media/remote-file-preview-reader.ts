import type { RemoteFilePreviewAddress } from '../../shared/remote-file-preview-address'
import type { RuntimeFileReadChunkResult } from '../../shared/runtime-file-contracts'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { getRuntimeEnvironmentRegistryRoot } from '../ipc/runtime-environments/runtime-environment-registry-root'

const STAT_TIMEOUT_MS = 15_000
// Why: previews share a two-call lane; a stalled chunk must free it well before a download's minute.
const READ_CHUNK_TIMEOUT_MS = 20_000

export const REMOTE_PREVIEW_UPDATE_REQUIRED_MESSAGE =
  'Previewing this file requires a newer Orca on the paired machine. Update it and try again.'

/** The pairing that minted a grant is gone; the grant can never answer again. */
export class RemotePreviewPairingChangedError extends Error {}

export type RemotePreviewFileSnapshot = { size: number; mtime: number; ctime?: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function callRemote(
  address: RemoteFilePreviewAddress,
  method: 'files.stat' | 'files.readChunk',
  params: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal
): Promise<unknown> {
  const response = await callRuntimeEnvironment(
    // The registry the pairing IPC writes; the canonical path can differ in casing.
    getRuntimeEnvironmentRegistryRoot(),
    address.environmentId,
    method,
    params,
    timeoutMs,
    address.expectedEnvironmentPairingRevision,
    undefined,
    { signal }
  )
  if (!response.ok) {
    if (response.error.code === 'runtime_environment_changed') {
      throw new RemotePreviewPairingChangedError(response.error.message)
    }
    // Why: a host without files.stat/readChunk can only be updated, never retried.
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
  const result = await callRemote(
    address,
    'files.stat',
    { worktree: address.worktree, relativePath: address.relativePath },
    STAT_TIMEOUT_MS,
    signal
  )
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
    'files.readChunk',
    { worktree: address.worktree, relativePath: address.relativePath, offset, length },
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
  const key = JSON.stringify([address.environmentId, revision])
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
