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
import { runRpcOperation } from './rpc-operation'

/** The host refuses the fifth concurrent read on one connection with `mobile_web_bundle_read_limited`,
 *  so the client never offers a fifth. Paging inside one asset stays sequential: the next offset is
 *  only known to be wanted once the previous reply says it is not the last. */
const MAX_CONCURRENT_ASSET_READS = 4

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
  throwIfStopped(args.signal, stopped.signal)
  const opened = await runRpcOperation(args.client, mobileWebBundleManifestRead, null)
  const manifest = opened.manifest
  const pending = [...manifest.assets]
  const assets = new Map<string, Uint8Array>()
  let receivedBytes = 0

  const worker = async (): Promise<void> => {
    try {
      for (let asset = pending.shift(); asset !== undefined; asset = pending.shift()) {
        const bytes = await readBundleAsset({
          client: args.client,
          asset,
          buildId: manifest.buildId,
          chunkBytes: opened.chunkBytes,
          signal: args.signal,
          stopped: stopped.signal
        })
        assets.set(asset.path, bytes)
        receivedBytes += bytes.byteLength
        args.onProgress?.({
          completedAssets: assets.size,
          totalAssets: manifest.assets.length,
          receivedBytes,
          totalBytes: manifest.totalBytes
        })
      }
    } catch (error) {
      // One failed asset stops the other three mid-asset, not just between assets: every chunk they
      // would still ask for holds one of the host's four read slots against the caller's retry.
      stopped.abort()
      throw error
    }
  }

  const workers = Math.min(MAX_CONCURRENT_ASSET_READS, pending.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return { manifest, assets, totalBytes: receivedBytes, elapsedMs: Date.now() - startedAt }
}

async function readBundleAsset(args: {
  client: RpcClient
  asset: MobileWebBundleAssetRead
  buildId: string
  chunkBytes: number
  signal?: AbortSignal
  stopped: AbortSignal
}): Promise<Uint8Array> {
  // Before the buffer, not after: an asset can be a tenth of the total ceiling, and a worker that
  // picked one up after a sibling failed would otherwise allocate it only to drop it.
  throwIfStopped(args.signal, args.stopped)
  const whole = new Uint8Array(args.asset.byteLength)
  let offset = 0
  for (;;) {
    throwIfStopped(args.signal, args.stopped)
    const chunk = await runRpcOperation(args.client, mobileWebBundleChunkRead, {
      buildId: args.buildId,
      path: args.asset.path,
      offset
    })
    assertChunkDescribesAsset(chunk, args.asset, args.buildId, offset)
    const bytes = decodeBase64(chunk.dataBase64)
    if (bytes.byteLength > args.chunkBytes) {
      throw new Error(
        `bundle chunk for ${args.asset.path} at ${offset} is ${bytes.byteLength} bytes, over the host's ${args.chunkBytes}`
      )
    }
    if (offset + bytes.byteLength > whole.byteLength) {
      throw new Error(`bundle asset ${args.asset.path} is longer than the manifest declares`)
    }
    whole.set(bytes, offset)
    offset += bytes.byteLength
    if (chunk.eof) {
      break
    }
    // Without this a host that keeps answering an unchanged offset with no bytes pages forever.
    if (bytes.byteLength === 0) {
      throw new Error(`bundle asset ${args.asset.path} made no progress at ${offset}`)
    }
  }
  if (offset !== whole.byteLength) {
    throw new Error(
      `bundle asset ${args.asset.path} ended at ${offset} of ${whole.byteLength} declared bytes`
    )
  }
  const digest = toHex(sha256(whole))
  if (digest !== args.asset.sha256) {
    throw new Error(`bundle asset ${args.asset.path} hashed ${digest}, not ${args.asset.sha256}`)
  }
  return whole
}

/**
 * Every chunk reply restates the build, path and offset it answers, and the whole asset's length and
 * hash. Checking all five is what makes a misrouted or stale reply a failure here instead of a
 * corrupt reassembly: a desktop that auto-updates mid-download answers a later chunk from a
 * different build, and nothing else in the reply would say so.
 */
function assertChunkDescribesAsset(
  chunk: {
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
  if (chunk.buildId !== buildId) {
    throw new Error(`bundle build changed mid-fetch: asked ${buildId}, served ${chunk.buildId}`)
  }
  if (chunk.path !== asset.path || chunk.offset !== offset) {
    throw new Error(
      `bundle chunk answered ${chunk.path} at ${chunk.offset}, not ${asset.path} at ${offset}`
    )
  }
  if (chunk.sha256 !== asset.sha256 || chunk.assetByteLength !== asset.byteLength) {
    throw new Error(`bundle asset ${asset.path} no longer matches the manifest entry`)
  }
}

/** The caller's abort is what it asked for; the internal one never leaves this module, because the
 *  asset that failed rejects first and is what `Promise.all` reports. */
function throwIfStopped(caller: AbortSignal | undefined, stopped: AbortSignal): void {
  if (caller?.aborted === true) {
    throw new Error('mobile web bundle fetch aborted')
  }
  if (stopped.aborted) {
    throw new Error('mobile web bundle fetch stopped after an earlier asset failed')
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
