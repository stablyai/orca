import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { MobileWebBundleAsset } from '../../../../shared/mobile-web-bundle/manifest-contract'

// Why keyed by buildId as well as path: buildId is a content hash, so a dev rebuild that swaps the
// bundle under a running app can never reuse a verdict recorded against the previous bytes.
const verdicts = new Map<string, Promise<boolean>>()

/** Tests own the process, so they own the cache; nothing in the app may call this. */
export function resetMobileWebBundleAssetVerdictsForTests(): void {
  verdicts.clear()
}

/**
 * Whether the bytes on disk still hash to what the manifest promised, computed once per asset and
 * then remembered. Concurrent first readers share one hash: the promise goes into the map before
 * the first await, so four parallel chunk requests for the same asset read it once, not four times.
 */
export function verifyMobileWebBundleAsset(
  root: string,
  buildId: string,
  asset: MobileWebBundleAsset
): Promise<boolean> {
  const key = `${buildId} ${asset.path}`
  const cached = verdicts.get(key)
  if (cached) {
    return cached
  }
  const verdict = hashAsset(root, asset).then(undefined, (error: unknown) => {
    // A read that failed is not evidence the bytes changed, so it is not remembered as a verdict.
    verdicts.delete(key)
    throw error
  })
  verdicts.set(key, verdict)
  return verdict
}

async function hashAsset(root: string, asset: MobileWebBundleAsset): Promise<boolean> {
  const handle = await open(join(root, asset.path), 'r')
  try {
    const hash = createHash('sha256')
    // Streamed rather than read whole: the contract ceiling is 10 MiB per asset, and this runs on
    // the main process's event loop.
    for await (const block of handle.createReadStream({ autoClose: false })) {
      hash.update(block)
    }
    return hash.digest('hex') === asset.sha256
  } finally {
    await handle.close()
  }
}

/**
 * The bytes of one asset in the range starting at `offset`, clamped to the asset's manifest length.
 *
 * Measured through asar (Electron 43): `open` hands back a descriptor on a per-asset copy the asar
 * layer materialises once under the OS temp dir and then reuses for the life of the process, so a
 * positional read costs one pread and never re-inflates the archive. Nothing to cache here.
 */
export async function readMobileWebBundleAssetChunk(
  root: string,
  asset: MobileWebBundleAsset,
  offset: number,
  length: number
): Promise<Buffer> {
  const wanted = Math.min(length, Math.max(0, asset.byteLength - offset))
  const buffer = Buffer.alloc(wanted)
  if (wanted === 0) {
    return buffer
  }
  // `asset.path` is a manifest member the caller matched exactly, never a client string, and the
  // manifest schema already rejects absolute paths, backslashes, and traversal segments.
  const handle = await open(join(root, asset.path), 'r')
  try {
    const { bytesRead } = await handle.read(buffer, 0, wanted, offset)
    return bytesRead === wanted ? buffer : buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
