import { sha256 } from '@noble/hashes/sha256'
import { mobileWebBundleManifestRead } from './mobile-web-bundle-operations'
import type {
  MobileWebBundleAssetRead,
  MobileWebBundleManifestRead
} from './mobile-web-bundle-reply-schemas'
import type { RpcClient } from './rpc-client'
import { MobileWebBundleFetchError } from './mobile-web-bundle-fetch-refusal'
import { runRpcOperation } from './rpc-operation'
import {
  mobileWebBundleWindowReader,
  type MobileWebBundleWindowHeader
} from './mobile-web-bundle-window-reader'

/** A window is one byte span of an asset on the grid the manifest reply named: a 48 KiB chunk, or a
 *  384 KiB range from a host that serves them.
 *
 *  The host refuses the fifth concurrent read on one connection with `mobile_web_bundle_read_limited`,
 *  so the client never offers a fifth. The four are window reads across the whole manifest, not one
 *  asset each: paging a large asset alone would put every one of its windows on the critical path. */
const MAX_CONCURRENT_WINDOW_READS = 4

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
  outstandingWindows: number
}

type WindowRead = { readonly asset: AssetReassembly; readonly offset: number }

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
  const reader = mobileWebBundleWindowReader(args.client, opened)
  const queue = planWindowReads(manifest.assets, reader.windowBytes)
  const assets = new Map<string, Uint8Array>()
  let receivedBytes = 0

  const readWindow = async ({ asset, offset }: WindowRead): Promise<void> => {
    const reply = await reader.read({
      buildId: manifest.buildId,
      path: asset.entry.path,
      offset
    })
    // A sibling already failed the fetch; this reply is not worth checking, decoding or reporting.
    if (stopped.signal.aborted) {
      return
    }
    assertWindowDescribesAsset(reply.header, asset.entry, manifest.buildId, offset)
    const bytes = reply.bytes(windowSlotBytes(asset.entry, offset, reader.windowBytes))
    assertWindowFillsItsSlot(
      asset.entry,
      offset,
      bytes.byteLength,
      reply.header.eof,
      reader.windowBytes
    )
    asset.whole.set(bytes, offset)
    asset.outstandingWindows -= 1
    if (asset.outstandingWindows === 0) {
      assets.set(asset.entry.path, verifyReassembledAsset(asset))
    }
    // Per window, not per asset: the largest asset goes first, so asset completions bunch at the end.
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
        await readWindow(read)
      }
    } catch (error) {
      // One failed window stops every other read: each read a worker would still send holds one of
      // the host's four slots against the caller's retry.
      stopped.abort()
      throw error
    }
  }

  const workers = Math.min(MAX_CONCURRENT_WINDOW_READS, queue.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))
  // The final window sends nothing after its last reply, so no worker would see this abort.
  throwIfCallerAborted(args.signal)
  return { manifest, assets, totalBytes: receivedBytes, elapsedMs: Date.now() - startedAt }
}

/** Largest asset first, so the biggest script's tail is never the last read left in flight. Offsets
 *  are on the window grid, so every read is known up front; `eof` still comes from the reply. */
function planWindowReads(
  entries: readonly MobileWebBundleAssetRead[],
  windowBytes: number
): WindowRead[] {
  const largestFirst = [...entries].sort((left, right) => right.byteLength - left.byteLength)
  return largestFirst.flatMap((entry) => {
    const count = Math.max(1, Math.ceil(entry.byteLength / windowBytes))
    const asset: AssetReassembly = {
      entry,
      whole: new Uint8Array(entry.byteLength),
      outstandingWindows: count
    }
    return Array.from({ length: count }, (_, index) => ({ asset, offset: index * windowBytes }))
  })
}

/** The bytes the grid slot at `offset` holds: a whole window, or the asset's tail. */
function windowSlotBytes(
  entry: MobileWebBundleAssetRead,
  offset: number,
  windowBytes: number
): number {
  return Math.min(windowBytes, entry.byteLength - offset)
}

/** Offsets are planned, so a reply is accepted only if it fills exactly its slot of the grid. */
function assertWindowFillsItsSlot(
  entry: MobileWebBundleAssetRead,
  offset: number,
  byteLength: number,
  eof: boolean,
  windowBytes: number
): void {
  const { path, byteLength: declared } = entry
  const expected = windowSlotBytes(entry, offset, windowBytes)
  if (byteLength === expected && eof === offset + windowBytes >= declared) {
    return
  }
  const end = offset + byteLength
  if (byteLength > windowBytes) {
    throw new MobileWebBundleFetchError(
      'chunk-oversize',
      `bundle window for ${path} at ${offset} is ${byteLength} bytes, over the ${windowBytes}-byte window`
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
      : `bundle window for ${path} at ${offset} carried ${byteLength} of ${expected} bytes without ending the asset`
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
 * Every window reply restates the build, path and offset it answers, and the whole asset's length and
 * hash. Checking all five is what makes a misrouted or stale reply a failure here instead of a
 * corrupt reassembly: a desktop that auto-updates mid-download answers a later window from a
 * different build, and nothing else in the reply would say so.
 */
function assertWindowDescribesAsset(
  reply: MobileWebBundleWindowHeader,
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
      `bundle window answered ${reply.path} at ${reply.offset}, not ${asset.path} at ${offset}`
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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
