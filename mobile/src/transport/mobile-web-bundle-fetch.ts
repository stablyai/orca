import { sha256 } from '@noble/hashes/sha256'
import {
  mobileWebBundleChunkRead,
  mobileWebBundleManifestRead
} from './mobile-web-bundle-operations'
import type {
  MobileWebBundleAssetRead,
  MobileWebBundleManifestRead
} from './mobile-web-bundle-reply-schemas'
import type { RpcClient } from './rpc-client'
import { MobileWebBundleFetchError } from './mobile-web-bundle-fetch-refusal'
import { runRpcOperation } from './rpc-operation'

/** The host refuses the fifth concurrent read on one connection with `mobile_web_bundle_read_limited`,
 *  so the client never offers a fifth. The four are chunk reads across the whole manifest, not one
 *  asset each: paging a large asset alone would put every one of its chunks on the critical path. */
const MAX_CONCURRENT_CHUNK_READS = 4

export type MobileWebBundleFetchProgress = {
  readonly completedAssets: number
  readonly totalAssets: number
  readonly receivedBytes: number
  readonly totalBytes: number
}

export type MobileWebBundleFetchResult = {
  readonly manifest: MobileWebBundleManifestRead
  readonly assets: ReadonlyMap<string, Uint8Array>
  readonly totalBytes: number
  readonly elapsedMs: number
}

type AssetReassembly = {
  readonly entry: MobileWebBundleAssetRead
  readonly whole: Uint8Array
  outstandingChunks: number
}

type ChunkRead = { readonly asset: AssetReassembly; readonly offset: number }

/**
 * Reads the manifest, pages every asset, and returns the verified bytes.
 *
 * Nothing is cached and nothing is rendered: this is the Phase A proof that the pipe carries a whole
 * bundle intact. Every asset is checked against the manifest's own sha256 before it is returned, so
 * a truncated or reordered reassembly fails here rather than in a webview much later.
 */
export async function fetchMobileWebBundle(args: {
  client: RpcClient
  signal?: AbortSignal
  onProgress?: (progress: MobileWebBundleFetchProgress) => void
}): Promise<MobileWebBundleFetchResult> {
  const startedAt = Date.now()
  const stopped = new AbortController()
  throwIfCallerAborted(args.signal)
  const opened = await runRpcOperation(args.client, mobileWebBundleManifestRead, null)
  const manifest = opened.manifest
  const queue = planChunkReads(manifest.assets, opened.chunkBytes)
  const assets = new Map<string, Uint8Array>()
  let receivedBytes = 0

  const readChunk = async ({ asset, offset }: ChunkRead): Promise<void> => {
    const reply = await runRpcOperation(args.client, mobileWebBundleChunkRead, {
      buildId: manifest.buildId,
      path: asset.entry.path,
      offset
    })
    // A sibling already failed the fetch; this reply is not worth checking, hashing or reporting.
    if (stopped.signal.aborted) {
      return
    }
    assertChunkDescribesAsset(reply, asset.entry, manifest.buildId, offset)
    const bytes = decodeBase64(reply.dataBase64)
    assertChunkFillsItsSlot(asset.entry, offset, bytes.byteLength, reply.eof, opened.chunkBytes)
    asset.whole.set(bytes, offset)
    asset.outstandingChunks -= 1
    if (asset.outstandingChunks === 0) {
      assets.set(asset.entry.path, verifyReassembledAsset(asset))
    }
    // Per chunk, not per asset: the largest asset goes first, so asset completions bunch at the end.
    receivedBytes += bytes.byteLength
    args.onProgress?.({
      completedAssets: assets.size,
      totalAssets: manifest.assets.length,
      receivedBytes,
      totalBytes: manifest.totalBytes
    })
  }

  const worker = async (): Promise<void> => {
    try {
      while (!stopped.signal.aborted) {
        const read = queue.shift()
        if (read === undefined) {
          return
        }
        throwIfCallerAborted(args.signal)
        await readChunk(read)
      }
    } catch (error) {
      // One failed chunk stops every other read: each read a worker would still send holds one of
      // the host's four slots against the caller's retry.
      stopped.abort()
      throw error
    }
  }

  const workers = Math.min(MAX_CONCURRENT_CHUNK_READS, queue.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))
  // The final window sends nothing after its last reply, so no worker would see this abort.
  throwIfCallerAborted(args.signal)
  return { manifest, assets, totalBytes: receivedBytes, elapsedMs: Date.now() - startedAt }
}

/** Largest asset first, so the biggest script's tail is never the last read left in flight. Offsets
 *  are the host's chunk grid, so every read is known up front; `eof` still comes from the reply. */
function planChunkReads(
  entries: readonly MobileWebBundleAssetRead[],
  chunkBytes: number
): ChunkRead[] {
  const largestFirst = [...entries].sort((left, right) => right.byteLength - left.byteLength)
  return largestFirst.flatMap((entry) => {
    const count = Math.max(1, Math.ceil(entry.byteLength / chunkBytes))
    const asset: AssetReassembly = {
      entry,
      whole: new Uint8Array(entry.byteLength),
      outstandingChunks: count
    }
    return Array.from({ length: count }, (_, index) => ({ asset, offset: index * chunkBytes }))
  })
}

/** Offsets are planned, so a reply is accepted only if it fills exactly its slot of the grid. */
function assertChunkFillsItsSlot(
  entry: MobileWebBundleAssetRead,
  offset: number,
  byteLength: number,
  eof: boolean,
  chunkBytes: number
): void {
  const { path, byteLength: declared } = entry
  const expected = Math.min(chunkBytes, declared - offset)
  if (byteLength === expected && eof === offset + chunkBytes >= declared) {
    return
  }
  const end = offset + byteLength
  if (byteLength > chunkBytes) {
    throw new MobileWebBundleFetchError(
      'chunk-oversize',
      `bundle chunk for ${path} at ${offset} is ${byteLength} bytes, over the host's ${chunkBytes}`
    )
  }
  if (byteLength > expected || (byteLength > 0 && !eof && end >= declared)) {
    throw new MobileWebBundleFetchError(
      'asset-overlong',
      `bundle asset ${path} is longer than the manifest declares`
    )
  }
  if (!eof && byteLength === 0) {
    throw new MobileWebBundleFetchError(
      'asset-no-progress',
      `bundle asset ${path} made no progress at ${offset}`
    )
  }
  throw new MobileWebBundleFetchError(
    'asset-short',
    eof
      ? `bundle asset ${path} ended at ${end} of ${declared} declared bytes`
      : `bundle chunk for ${path} at ${offset} carried ${byteLength} of ${expected} bytes without ending the asset`
  )
}

/** Every slot was accepted exactly once, so only the hash is left to say the bytes are right. */
function verifyReassembledAsset(asset: AssetReassembly): Uint8Array {
  const digest = toHex(sha256(asset.whole))
  if (digest !== asset.entry.sha256) {
    throw new MobileWebBundleFetchError(
      'asset-checksum-mismatch',
      `bundle asset ${asset.entry.path} hashed ${digest}, not ${asset.entry.sha256}`
    )
  }
  return asset.whole
}

/**
 * Every chunk reply restates the build, path and offset it answers, and the whole asset's length and
 * hash. Checking all five is what makes a misrouted or stale reply a failure here instead of a
 * corrupt reassembly: a desktop that auto-updates mid-download answers a later chunk from a
 * different build, and nothing else in the reply would say so.
 */
function assertChunkDescribesAsset(
  reply: {
    buildId: string
    path: string
    offset: number
    assetByteLength: number
    sha256: string
  },
  asset: MobileWebBundleAssetRead,
  buildId: string,
  offset: number
): void {
  if (reply.buildId !== buildId) {
    throw new MobileWebBundleFetchError(
      'build-changed-mid-fetch',
      `bundle build changed mid-fetch: asked ${buildId}, served ${reply.buildId}`
    )
  }
  if (reply.path !== asset.path || reply.offset !== offset) {
    throw new MobileWebBundleFetchError(
      'chunk-misrouted',
      `bundle chunk answered ${reply.path} at ${reply.offset}, not ${asset.path} at ${offset}`
    )
  }
  if (reply.sha256 !== asset.sha256 || reply.assetByteLength !== asset.byteLength) {
    throw new MobileWebBundleFetchError(
      'asset-entry-changed',
      `bundle asset ${asset.path} no longer matches the manifest entry`
    )
  }
}

/** Only the caller's abort surfaces as `fetch-stopped`; an internal stop rejects with the failure
 *  that caused it. */
function throwIfCallerAborted(caller: AbortSignal | undefined): void {
  if (caller?.aborted === true) {
    throw new MobileWebBundleFetchError('fetch-stopped', 'mobile web bundle fetch aborted')
  }
}

/** Metro ships no Buffer; `atob` is the decoder the pairing and E2EE paths already run on Hermes. */
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
