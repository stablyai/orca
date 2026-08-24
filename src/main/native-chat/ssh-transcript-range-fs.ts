import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'
import { getSshFilesystemProviderSnapshot } from '../providers/ssh-filesystem-dispatch'
import type { IFilesystemProvider } from '../providers/types'
import { TranscriptHostUnverifiableError } from './transcript-host-verdict'
import {
  TranscriptRangeReadInvalidatedError,
  type TranscriptFileStamp,
  type TranscriptRangeFs
} from './transcript-range-fs'

type ProviderGeneration = {
  provider: IFilesystemProvider
  generation: number
}

const STABILITY_BOUNDARY_BYTES = 64

function requireSameProvider(connectionId: string, expected: ProviderGeneration): void {
  const current = getSshFilesystemProviderSnapshot(connectionId)
  if (
    !current ||
    current.provider !== expected.provider ||
    current.generation !== expected.generation
  ) {
    throw new TranscriptHostUnverifiableError()
  }
}

export async function createSshTranscriptRangeFs(
  connectionId: string,
  signal?: AbortSignal
): Promise<TranscriptRangeFs> {
  const snapshot = getSshFilesystemProviderSnapshot(connectionId)
  if (!snapshot?.provider.readFileRange) {
    throw new TranscriptHostUnverifiableError()
  }
  if (
    snapshot.provider.supportsFileRangeRead &&
    !(await snapshot.provider.supportsFileRangeRead({ signal }))
  ) {
    throw new TranscriptHostUnverifiableError()
  }
  const providerSnapshot: ProviderGeneration = snapshot
  requireSameProvider(connectionId, providerSnapshot)
  const provider = providerSnapshot.provider
  async function read(
    filePath: string,
    position: number,
    length: number,
    readSignal?: AbortSignal
  ) {
    readSignal?.throwIfAborted()
    const parts: Buffer[] = []
    let remaining = length
    let cursor = position
    while (remaining > 0) {
      requireSameProvider(connectionId, providerSnapshot)
      const window = Math.min(remaining, MAX_FILE_RANGE_READ_BYTES)
      const result = await provider.readFileRange!(filePath, cursor, window, {
        signal: readSignal
      })
      requireSameProvider(connectionId, providerSnapshot)
      const bytes = result.bytes.subarray(0, result.bytesRead)
      parts.push(bytes)
      cursor += bytes.length
      remaining -= bytes.length
      if (bytes.length < window) {
        break
      }
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts)
  }
  async function stat(
    filePath: string,
    statSignal?: AbortSignal,
    captureBoundary = false
  ): Promise<TranscriptFileStamp> {
    statSignal?.throwIfAborted()
    requireSameProvider(connectionId, providerSnapshot)
    const stamp = await provider.stat(filePath, { signal: statSignal })
    requireSameProvider(connectionId, providerSnapshot)
    const mtimeMs = stamp.mtimeMs ?? stamp.mtime
    const boundaryLength = Math.min(stamp.size, STABILITY_BOUNDARY_BYTES)
    const boundaryFingerprint =
      captureBoundary && boundaryLength > 0
        ? (await read(filePath, stamp.size - boundaryLength, boundaryLength, statSignal)).toString(
            'base64'
          )
        : undefined
    return {
      size: stamp.size,
      identity: `${providerSnapshot.generation}:${stamp.dev ?? 0}:${stamp.ino ?? 0}`,
      mtimeMs,
      ctimeMs: mtimeMs,
      ...(boundaryFingerprint ? { boundaryFingerprint } : {})
    }
  }
  const rangeFs: TranscriptRangeFs = {
    stat,
    read,
    async assertStable(filePath, openingStamp, stableSignal) {
      const closingStamp = await stat(filePath, stableSignal)
      const identityChanged = closingStamp.identity !== openingStamp.identity
      const versionChanged = closingStamp.mtimeMs !== openingStamp.mtimeMs
      if (identityChanged || closingStamp.size < openingStamp.size) {
        throw new TranscriptRangeReadInvalidatedError()
      }
      if (closingStamp.size === openingStamp.size) {
        if (versionChanged) {
          throw new TranscriptRangeReadInvalidatedError()
        }
        if (openingStamp.size === 0) {
          return
        }
      }
      if (!openingStamp.boundaryFingerprint) {
        throw new TranscriptRangeReadInvalidatedError()
      }
      const boundaryLength = Math.min(openingStamp.size, STABILITY_BOUNDARY_BYTES)
      const boundary = await read(
        filePath,
        openingStamp.size - boundaryLength,
        boundaryLength,
        stableSignal
      )
      if (boundary.toString('base64') !== openingStamp.boundaryFingerprint) {
        throw new TranscriptRangeReadInvalidatedError()
      }
    }
  }
  return rangeFs
}
