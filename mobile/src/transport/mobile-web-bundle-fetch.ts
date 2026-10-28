import { CryptoDigestAlgorithm, digest } from 'expo-crypto'
import { mobileWebBundleManifestRead } from './mobile-web-bundle-operations'
import type {
  MobileWebBundleAssetRead,
  MobileWebBundleManifestRead
} from './mobile-web-bundle-reply-schemas'
import type { RpcClient } from './rpc-client'
import { MobileWebBundleFetchError } from './mobile-web-bundle-fetch-refusal'
import { runRpcOperation } from './rpc-operation'
import {
  createWindowStallClock,
  MOBILE_WEB_BUNDLE_WINDOW_STALL_MS
} from './mobile-web-bundle-window-stall-clock'
import {
  mobileWebBundleWindowReader,
  type MobileWebBundleWindowHeader
} from './mobile-web-bundle-window-reader'

// Limit concurrent windows across all assets to the host’s four slots; one reader per asset serializes large scripts.
const MAX_CONCURRENT_WINDOW_READS = 4

// Bound pending-read lifetimes so failed fetches release reassembly buffers after the queued-reply allowance.
const WINDOW_READ_BACKSTOP_MS =
  (MAX_CONCURRENT_WINDOW_READS + 1) * MOBILE_WEB_BUNDLE_WINDOW_STALL_MS

export type MobileWebBundleFetchProgress = {
  readonly completedAssets: number
  readonly totalAssets: number
  readonly receivedBytes: number
  readonly totalBytes: number
}

export type MobileWebBundleFetchResult = {
  readonly manifest: MobileWebBundleManifestRead
  readonly assets: ReadonlyMap<string, Uint8Array>
  // Already on disk (kept as it landed, or in the active generation); stageGeneration must place each or fail.
  readonly reused: readonly string[]
  readonly totalBytes: number
  readonly elapsedMs: number
}

type AssetReassembly = {
  readonly entry: MobileWebBundleAssetRead
  readonly whole: Uint8Array<ArrayBuffer>
  outstandingWindows: number
}

type WindowRead = { readonly asset: AssetReassembly; readonly offset: number }

// Reuse only matching content hash/length from verified files: the active generation or this build's interrupted download.
export type MobileWebBundleReusableAssets = {
  readonly has: (asset: MobileWebBundleAssetRead) => boolean
  // Absent/short/mismatched files fall back to download and checks never reject.
  readonly check: (asset: MobileWebBundleAssetRead) => Promise<boolean>
  // Persist a verified asset as it lands so an interrupted fetch resumes from it; false leaves it in memory.
  readonly keep: (asset: MobileWebBundleAssetRead, bytes: Uint8Array) => Promise<boolean>
}

// Verify every asset hash before returning; report only wire bytes so reuse does not make progress jump then stall.
export async function fetchMobileWebBundle(args: {
  client: RpcClient
  signal?: AbortSignal
  onProgress?: (progress: MobileWebBundleFetchProgress) => void
  // Opened per manifest so a resumed download of the same build can reuse what it kept.
  openReusable?: (manifest: MobileWebBundleManifestRead) => Promise<MobileWebBundleReusableAssets>
}): Promise<MobileWebBundleFetchResult> {
  const startedAt = Date.now()
  const stopped = new AbortController()
  throwIfCallerAborted(args.signal)
  const opened = await runRpcOperation(args.client, mobileWebBundleManifestRead, null)
  const manifest = opened.manifest
  const reader = mobileWebBundleWindowReader(args.client, opened)
  // Unavailable reuse is a cache miss, not a download failure.
  const reusable = await args.openReusable?.(manifest).catch(() => undefined)
  const candidates = new Set(
    reusable === undefined ? [] : manifest.assets.filter((entry) => reusable.has(entry))
  )
  const fetched = manifest.assets.filter((entry) => !candidates.has(entry))
  const assets = new Map<string, Uint8Array>()
  const reused: string[] = []
  let receivedBytes = 0
  let downloadBytes = 0
  let downloadAssets = 0
  let downloadedAssets = 0
  const stallClock = createWindowStallClock(stopped)
  const reportProgress = (): void => {
    args.onProgress?.({
      completedAssets: downloadedAssets,
      totalAssets: downloadAssets,
      receivedBytes,
      totalBytes: downloadBytes
    })
  }

  const readWindow = async ({ asset, offset }: WindowRead): Promise<void> => {
    const reply = await reader.read(
      { buildId: manifest.buildId, path: asset.entry.path, offset },
      { timeoutMs: WINDOW_READ_BACKSTOP_MS }
    )
    stallClock.arm()
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
      const verified = await verifyReassembledAsset(asset)
      // Keep verified bytes even after a sibling failed; skip once the caller left, as its host may since be removed.
      const kept =
        args.signal?.aborted !== true && reusable !== undefined
          ? await reusable.keep(asset.entry, verified)
          : false
      // A sibling failed while this hashed; the fetch already rejected with that failure.
      if (stopped.signal.aborted) {
        return
      }
      if (kept) {
        reused.push(asset.entry.path)
      } else {
        assets.set(asset.entry.path, verified)
      }
      downloadedAssets += 1
    }
    // Per window, not per asset: the largest asset goes first, so asset completions bunch at the end.
    receivedBytes += bytes.byteLength
    reportProgress()
  }

  const readWindows = async (entries: readonly MobileWebBundleAssetRead[]): Promise<void> => {
    const queue = planWindowReads(entries, reader.windowBytes)
    if (queue.length === 0) {
      return
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
        // Stop sibling dispatch after failure so retained reads cannot consume the host slots needed by a retry.
        stopped.abort()
        throw error
      }
    }
    const workers = Math.min(MAX_CONCURRENT_WINDOW_READS, queue.length)
    stallClock.arm()
    try {
      await Promise.race([
        Promise.all(Array.from({ length: workers }, () => worker())),
        stallClock.stalled
      ])
    } finally {
      stallClock.disarm()
    }
  }

  const reuseCandidates = async (): Promise<MobileWebBundleAssetRead[]> => {
    const missed: MobileWebBundleAssetRead[] = []
    for (const entry of candidates) {
      if (stopped.signal.aborted) {
        break
      }
      throwIfCallerAborted(args.signal)
      if (await reusable?.check(entry)) {
        reused.push(entry.path)
      } else {
        missed.push(entry)
      }
    }
    return missed
  }

  const countDownload = (entries: readonly MobileWebBundleAssetRead[]): void => {
    downloadAssets += entries.length
    downloadBytes += entries.reduce((sum, entry) => sum + entry.byteLength, 0)
  }

  try {
    countDownload(fetched)
    // The caption's total before any byte, when it is not the whole bundle the session assumed.
    if (candidates.size > 0) {
      reportProgress()
    }
    // Overlap native cache stats with network reads rather than delaying download.
    const [, missed] = await Promise.all([readWindows(fetched), reuseCandidates()])
    if (missed.length > 0 && !stopped.signal.aborted) {
      countDownload(missed)
      reportProgress()
      await readWindows(missed)
    }
  } finally {
    stopped.abort()
    stallClock.disarm()
  }
  // The final window sends nothing after its last reply, so no worker would see this abort.
  throwIfCallerAborted(args.signal)
  return { manifest, assets, reused, totalBytes: receivedBytes, elapsedMs: Date.now() - startedAt }
}

// Plan all grid offsets largest-asset first so its tail cannot serialize the end; still validate eof replies.
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

// Native: hashing in JS held the JS thread for seconds, and React's progress renders waited on it.
export async function sha256HexOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes)))
}

async function verifyReassembledAsset(asset: AssetReassembly): Promise<Uint8Array> {
  const hashed = await sha256HexOf(asset.whole)
  if (hashed !== asset.entry.sha256) {
    throw new MobileWebBundleFetchError(
      'asset-checksum-mismatch',
      `bundle asset ${asset.entry.path} hashed ${hashed}, not ${asset.entry.sha256}`
    )
  }
  return asset.whole
}

// Validate build/path/offset/length/hash echoes so misrouted or post-update replies cannot corrupt reassembly.
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
