import { CryptoDigestAlgorithm, digest } from 'expo-crypto'
import { PrioritySemaphore } from '../../../../src/shared/priority-semaphore'
import { mobileWebBundleManifestRead } from './mobile-web-bundle-operations'
import type {
  MobileWebBundleAssetRead,
  MobileWebBundleManifestRead,
  MobileWebBundleManifestReply
} from './mobile-web-bundle-reply-schemas'
import type { RpcClient } from '../rpc/rpc-client-contract'
import { MobileWebBundleFetchError } from './mobile-web-bundle-fetch-refusal'
import { markRpcDeliveryUnknown } from '../rpc/rpc-delivery-ambiguity'
import { runRpcOperation } from '../rpc/rpc-operation'
import { mobileWebBundleWindowReader } from './mobile-web-bundle-window-reader'
import {
  assertWindowDescribesAsset,
  assertWindowFillsItsSlot,
  windowSlotBytes
} from './mobile-web-bundle-window-checks'

// The host admits four window reads per connection; one reader per asset would serialize large scripts.
const MAX_CONCURRENT_WINDOW_READS = 4
// Shells on one host share its client, so their fetches share its read slots; per-fetch limits got the second fetch refused.
type ConnectionReads = { readonly slots: PrioritySemaphore; lastWindowAt: number }
const connectionReads = new WeakMap<RpcClient, ConnectionReads>()

function connectionReadsOf(client: RpcClient): ConnectionReads {
  let reads = connectionReads.get(client)
  if (reads === undefined) {
    reads = { slots: new PrioritySemaphore(MAX_CONCURRENT_WINDOW_READS), lastWindowAt: 0 }
    connectionReads.set(client, reads)
  }
  return reads
}

// Time fetch-wide inactivity; a queued read on a slow moving link can exceed a per-request stall budget (#29697).
export const MOBILE_WEB_BUNDLE_WINDOW_STALL_MS = 30_000
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
  // stageGeneration must copy every reused asset or fail rather than stage an incomplete tree.
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

// Reuse only matching content hash/length from immutable verified generations.
export type MobileWebBundleReusableAssets = {
  readonly has: (asset: MobileWebBundleAssetRead) => boolean
  // Stat without reading bytes; absent/short files fall back to download and checks never reject.
  readonly check: (asset: MobileWebBundleAssetRead) => Promise<boolean>
}

// Verify every asset hash before returning; report only wire bytes so reuse does not make progress jump then stall.
export async function fetchMobileWebBundle(args: {
  client: RpcClient
  signal?: AbortSignal
  onProgress?: (progress: MobileWebBundleFetchProgress) => void
  reusable?: MobileWebBundleReusableAssets
  // The manifest the caller already read; windows name its build id, so a build the desktop since replaced fails the fetch.
  opened?: MobileWebBundleManifestReply
}): Promise<MobileWebBundleFetchResult> {
  const startedAt = Date.now()
  const stopped = new AbortController()
  throwIfCallerAborted(args.signal)
  const opened =
    args.opened ?? (await runRpcOperation(args.client, mobileWebBundleManifestRead, null))
  throwIfCallerAborted(args.signal)
  const manifest = opened.manifest
  const reader = mobileWebBundleWindowReader(args.client, opened)
  const connection = connectionReadsOf(args.client)
  const candidates = new Set(
    args.reusable === undefined ? [] : manifest.assets.filter((entry) => args.reusable?.has(entry))
  )
  const fetched = manifest.assets.filter((entry) => !candidates.has(entry))
  const assets = new Map<string, Uint8Array>()
  const reused: string[] = []
  let receivedBytes = 0
  let downloadBytes = 0
  let downloadAssets = 0
  let downloadedAssets = 0
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  let failStalled: (error: Error) => void = () => {}
  const stalled = new Promise<never>((_, reject) => {
    failStalled = reject
  })
  const disarmStallClock = (): void => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer)
      stallTimer = null
    }
  }
  const armStallClock = (delayMs = MOBILE_WEB_BUNDLE_WINDOW_STALL_MS): void => {
    disarmStallClock()
    // A read that lands after the fetch settled must not leave a timer behind.
    if (stopped.signal.aborted) {
      return
    }
    stallTimer = setTimeout(() => {
      // Windows still arriving for another fetch on this connection mean this one waits for slots, not on a dead link.
      const idleMs = Date.now() - connection.lastWindowAt
      if (idleMs >= 0 && idleMs < MOBILE_WEB_BUNDLE_WINDOW_STALL_MS) {
        armStallClock(MOBILE_WEB_BUNDLE_WINDOW_STALL_MS - idleMs)
        return
      }
      stopped.abort()
      failStalled(
        markRpcDeliveryUnknown(
          new Error(
            `mobile web bundle fetch stalled: no window arrived in ${MOBILE_WEB_BUNDLE_WINDOW_STALL_MS}ms`
          )
        )
      )
    }, delayMs)
  }
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
    // Any reply is connection activity, even one this fetch no longer wants; fetches waiting for its slot count on it.
    connection.lastWindowAt = Date.now()
    throwIfCallerAborted(args.signal)
    armStallClock()
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
      throwIfCallerAborted(args.signal)
      // A sibling failed while this hashed; the fetch already rejected with that failure.
      if (stopped.signal.aborted) {
        return
      }
      assets.set(asset.entry.path, verified)
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
          // Take work before a slot, so a fetch with nothing left never waits behind another's reads.
          const read = queue.shift()
          if (read === undefined) {
            return
          }
          // Rejects only when this fetch stopped while waiting; the failure that stopped it is already reported.
          const release = await connection.slots.acquire(0, stopped.signal).catch(() => null)
          if (release === null) {
            return
          }
          try {
            // A sibling may fail between the grant and this resume.
            if (stopped.signal.aborted) {
              return
            }
            throwIfCallerAborted(args.signal)
            await readWindow(read)
          } finally {
            release()
          }
        }
      } catch (error) {
        // Stop sibling dispatch after failure so retained reads cannot consume the host slots needed by a retry.
        stopped.abort()
        throw error
      }
    }
    const workers = Math.min(MAX_CONCURRENT_WINDOW_READS, queue.length)
    armStallClock()
    try {
      await Promise.race([Promise.all(Array.from({ length: workers }, () => worker())), stalled])
    } finally {
      disarmStallClock()
    }
  }

  const reuseCandidates = async (): Promise<MobileWebBundleAssetRead[]> => {
    const missed: MobileWebBundleAssetRead[] = []
    for (const entry of candidates) {
      if (stopped.signal.aborted) {
        break
      }
      throwIfCallerAborted(args.signal)
      if (await args.reusable?.check(entry)) {
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
    throwIfCallerAborted(args.signal)
    if (missed.length > 0 && !stopped.signal.aborted) {
      countDownload(missed)
      reportProgress()
      await readWindows(missed)
    }
  } finally {
    stopped.abort()
    disarmStallClock()
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

async function verifyReassembledAsset(asset: AssetReassembly): Promise<Uint8Array> {
  // Native: hashing in JS held the JS thread for seconds, and React's progress renders waited on it.
  const hashed = toHex(new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, asset.whole)))
  if (hashed !== asset.entry.sha256) {
    throw new MobileWebBundleFetchError(
      'asset-checksum-mismatch',
      `bundle asset ${asset.entry.path} hashed ${hashed}, not ${asset.entry.sha256}`
    )
  }
  return asset.whole
}

/** Only the caller's abort surfaces as `fetch-stopped`; an internal stop rejects with the failure
 *  that caused it. */
function throwIfCallerAborted(caller: AbortSignal | undefined): void {
  if (caller?.aborted === true) {
    throw new MobileWebBundleFetchError('fetch-stopped', 'mobile web bundle fetch aborted')
  }
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
