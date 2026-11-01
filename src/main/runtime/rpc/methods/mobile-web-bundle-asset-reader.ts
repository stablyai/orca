import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { MobileWebBundleAsset } from '../../../../shared/mobile-web-bundle/manifest-contract'

// Include content-hash buildId so live dev rebuilds cannot reuse verdicts for previous bytes.
const verdicts = new Map<string, Promise<boolean>>()

/** Tests own the process, so they own the cache; nothing in the app may call this. */
export function resetMobileWebBundleAssetVerdictsForTests(): void {
  verdicts.clear()
}

/** Cache one asset hash verdict per build; store the pending promise before await so concurrent readers share the hash. */
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
    // Stream assets (up to 10 MiB) to bound main-process memory.
    for await (const block of handle.createReadStream({ autoClose: false })) {
      hash.update(block)
    }
    return hash.digest('hex') === asset.sha256
  } finally {
    await handle.close()
  }
}

/** Fill a manifest-bounded window; early EOF means asset-changed, never a short page. Packaged bundles are unpacked, so positional reads need no file cache (#27976). */
export async function readMobileWebBundleAssetWindow(
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
  // Use only the exact manifest member; its schema rejects absolute paths, backslashes and traversal.
  const handle = await open(join(root, asset.path), 'r')
  try {
    const filled = await fillMobileWebBundleReadWindow(handle, buffer, wanted, offset)
    if (filled !== wanted) {
      throw new Error(
        `short read of ${asset.path}: ${String(filled)} of ${String(wanted)} bytes at ${String(offset)}`
      )
    }
    return buffer
  } finally {
    await handle.close()
  }
}

/** Keep the positional reader structural for tests; importing relay's equivalent would pull its dispatcher graph into the runtime bundle. */
type PositionalReader = {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>
}

/** Fill the window across short reads; only a zero-byte read proves early EOF. */
export async function fillMobileWebBundleReadWindow(
  reader: PositionalReader,
  buffer: Buffer,
  wanted: number,
  offset: number
): Promise<number> {
  let filled = 0
  while (filled < wanted) {
    const { bytesRead } = await reader.read(buffer, filled, wanted - filled, offset + filled)
    if (bytesRead === 0) {
      break
    }
    filled += bytesRead
  }
  return filled
}
