import { Buffer } from 'buffer/'
import { sha256 } from '@noble/hashes/sha256'
import {
  MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS,
  MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES
} from '../../../src/shared/mobile-web/package-rpc-contract'
import type {
  MobileWebAsset,
  MobileWebManifest
} from '../../../src/shared/mobile-web/manifest-contract'
import {
  decodeGzipMobileWebPackageChunk,
  decodeRawMobileWebPackageChunk
} from './mobile-web-package-chunk-decoder'
import {
  MobileWebPackageDownloadError,
  requestMobileWebPackageResult,
  type MobileWebPackageRequest,
  type MobileWebPackageStager
} from './mobile-web-package-download-contract'

const MOBILE_WEB_PACKAGE_READ_LIMITED_RETRIES = 4
const MOBILE_WEB_PACKAGE_READ_LIMITED_BACKOFF_MS = 50
const MOBILE_WEB_PACKAGE_CUTOVER_RETRIES = 4
const MOBILE_WEB_PACKAGE_CUTOVER_BACKOFF_MS = 250

type ChunkTask = { asset: MobileWebAsset; offset: number; expectedLength: number }
type SettledChunk = { bytes: Uint8Array } | { failure: unknown }

// The native stage appends each asset chunk at the file's current length, so chunks must reach
// the stager in offset order even though the reads themselves overlap.
export async function downloadAssetChunks<TCommit>(args: {
  request: MobileWebPackageRequest
  stager: MobileWebPackageStager<TCommit>
  manifest: MobileWebManifest
  chunkBytes: number
  signal: AbortSignal | undefined
  useGzip: boolean
  rangeBytes: number
  maxConcurrentRequests: number
  onChunkWritten: (bytes: number) => void
}): Promise<void> {
  const tasks = planChunkTasks(args.manifest, args.rangeBytes)
  const inFlight = new Map<number, Promise<SettledChunk>>()
  let window = clampWindow(args.maxConcurrentRequests)
  let issued = 0
  let assetHash = sha256.create()

  const shrinkWindow = (): void => {
    window = Math.max(1, window - 1)
  }
  for (let drained = 0; drained < tasks.length; drained += 1) {
    while (issued < tasks.length && issued - drained < window) {
      const task = tasks[issued]!
      inFlight.set(issued, fetchChunk(args, task, shrinkWindow))
      issued += 1
    }
    const settled = await inFlight.get(drained)!
    inFlight.delete(drained)
    if ('failure' in settled) {
      throw settled.failure
    }
    throwIfAborted(args.signal)
    const task = tasks[drained]!
    assetHash.update(settled.bytes)
    // A ranged read answers several stage chunks at once; the native stage still appends
    // one 48 KiB chunk at a time.
    for (let written = 0; written < settled.bytes.byteLength; written += args.chunkBytes) {
      const slice = settled.bytes.subarray(written, written + args.chunkBytes)
      await args.stager.writeAssetChunk(task.asset, task.offset + written, slice)
      args.onChunkWritten(slice.byteLength)
    }
    if (task.offset + task.expectedLength === task.asset.byteLength) {
      if (Buffer.from(assetHash.digest()).toString('hex') !== task.asset.sha256) {
        throw new MobileWebPackageDownloadError('asset_integrity_failed')
      }
      assetHash = sha256.create()
      await args.stager.finishAsset(task.asset)
    }
  }
}

function planChunkTasks(manifest: MobileWebManifest, rangeBytes: number): ChunkTask[] {
  const tasks: ChunkTask[] = []
  for (const asset of manifest.assets) {
    for (let offset = 0; offset < asset.byteLength; offset += rangeBytes) {
      tasks.push({
        asset,
        offset,
        expectedLength: Math.min(rangeBytes, asset.byteLength - offset)
      })
    }
  }
  return tasks
}

// Ranged reads ride mobileWeb.package.asset.gzip's optional `length`, which strict-schema
// hosts predating MOBILE_WEB_PACKAGE_RANGE_RUNTIME_CAPABILITY reject.
export function clampRangeBytes(chunkBytes: number, rangeBytes: number | undefined): number {
  if (rangeBytes === undefined || rangeBytes <= chunkBytes) {
    return chunkBytes
  }
  const chunks = Math.min(
    Math.floor(MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES / chunkBytes),
    Math.floor(rangeBytes / chunkBytes)
  )
  return Math.max(1, chunks) * chunkBytes
}

function clampWindow(maxConcurrentRequests: number): number {
  return Number.isInteger(maxConcurrentRequests)
    ? Math.min(MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS, Math.max(1, maxConcurrentRequests))
    : 1
}

// Never rejects: a queued read that fails while an earlier one is still draining would
// otherwise surface as an unhandled rejection before the drain loop reaches it.
async function fetchChunk<TCommit>(
  args: {
    request: MobileWebPackageRequest
    stager: MobileWebPackageStager<TCommit>
    manifest: MobileWebManifest
    signal: AbortSignal | undefined
    useGzip: boolean
    chunkBytes: number
    rangeBytes: number
  },
  task: ChunkTask,
  onReadLimited: () => void
): Promise<SettledChunk> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      throwIfAborted(args.signal)
      const result = await requestMobileWebPackageResult(
        args.request,
        args.useGzip ? 'mobileWeb.package.asset.gzip' : 'mobileWeb.package.asset',
        {
          buildId: args.manifest.buildId,
          path: task.asset.path,
          offset: task.offset,
          ...(args.rangeBytes > args.chunkBytes ? { length: args.rangeBytes } : {})
        }
      )
      throwIfAborted(args.signal)
      const decode = args.useGzip ? decodeGzipMobileWebPackageChunk : decodeRawMobileWebPackageChunk
      const bytes = decode(
        result,
        args.manifest.buildId,
        task.asset.path,
        task.offset,
        task.expectedLength,
        task.asset.byteLength
      )
      return bytes ? { bytes } : { failure: new MobileWebPackageDownloadError('invalid_chunk') }
    } catch (error) {
      // Why: a host whose per-connection read budget is narrower than ours must slow the
      // pipeline down, not fail the whole package.
      if (
        error instanceof MobileWebPackageDownloadError &&
        error.code === 'mobile_web_package_read_limited' &&
        attempt < MOBILE_WEB_PACKAGE_READ_LIMITED_RETRIES
      ) {
        onReadLimited()
        await sleep(MOBILE_WEB_PACKAGE_READ_LIMITED_BACKOFF_MS * (attempt + 1))
        continue
      }
      // Why: a seamless cutover replaces the logical session without changing connState, so the
      // request is dead but the download is not; the user should not have to tap Retry.
      if (
        error instanceof MobileWebPackageDownloadError &&
        error.retryable &&
        attempt < MOBILE_WEB_PACKAGE_CUTOVER_RETRIES
      ) {
        await sleep(MOBILE_WEB_PACKAGE_CUTOVER_BACKOFF_MS * (attempt + 1))
        continue
      }
      return { failure: error }
    }
  }
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new MobileWebPackageDownloadError('cancelled')
  }
}
