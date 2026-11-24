import { CryptoDigestAlgorithm, digest } from 'expo-crypto'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { runRpcOperation } from '../../transport/rpc/rpc-operation'
import { fetchMobileWebBundle } from '../../transport/web-bundle/mobile-web-bundle-fetch'
import { mobileWebBundleManifestRead } from '../../transport/web-bundle/mobile-web-bundle-operations'
import {
  isDeferredAsset,
  type MobileWebBundleAssetRead
} from '../../transport/web-bundle/mobile-web-bundle-reply-schemas'
import { requireStorablePath } from './generation-asset-path'
import { joinUri } from './generation-cache-uri'
import { assetsOnDisk } from './generation-manifest-read'
import type { ActiveGeneration } from './generation-store'
import type { GenerationFileSystem } from './generation-store-file-system'

// Verified bytes of the deferred assets asked for, by sha256.
export type FetchDeferredAssets = (
  missing: readonly MobileWebBundleAssetRead[]
) => Promise<ReadonlyMap<string, Uint8Array>>

// Callers passing the same scope share one fill (pages of one credential, not a retired one).
export type DeferredAssetsFiller = (
  hostKey: string,
  buildId: string,
  fetch: FetchDeferredAssets,
  scope?: string
) => Promise<void>

// Write the active build's missing deferred code into its own tree, where the native view already maps
// it; the fetch runs outside the store queue, and each queued step rechecks the build and the disk.
export function deferredAssetsFiller(
  fs: GenerationFileSystem,
  serialize: <T>(operation: () => Promise<T>) => Promise<T>,
  readActive: (hostKey: string) => Promise<ActiveGeneration | null>
): DeferredAssetsFiller {
  // Pages of one host share a fill, so two first diagrams download the engine once.
  const filling = new Map<string, Promise<void>>()
  const fill: DeferredAssetsFiller = async (hostKey, buildId, fetch) => {
    const missingNow = async () => {
      const active = await readActive(hostKey)
      if (active?.buildId !== buildId) {
        throw new Error(`build ${buildId} is no longer this host's active build`)
      }
      const deferred = active.manifest.assets.filter(isDeferredAsset)
      const whole = new Set((await assetsOnDisk(fs, active.directory, deferred)).map((a) => a.path))
      return { active, missing: deferred.filter((asset) => !whole.has(asset.path)) }
    }
    const before = await serialize(missingNow)
    if (before.missing.length === 0) {
      return
    }
    const fetched = await fetch(before.missing)
    // Hash against this phone's own entry: the desktop's manifest only said what it would send, and
    // other hosts' builds reuse these files by hash and length alone.
    for (const asset of before.missing) {
      const bytes = fetched.get(asset.sha256)
      if (bytes === undefined || !(await isExactly(asset, bytes))) {
        throw new Error(`the desktop sent no matching copy of deferred asset ${asset.path}`)
      }
    }
    await serialize(async () => {
      // Another page may have written it meanwhile; rewriting would tear a file a WebView is reading.
      const { active, missing } = await missingNow()
      for (const asset of missing) {
        const bytes = fetched.get(asset.sha256)
        if (bytes === undefined) {
          throw new Error(`the desktop sent no copy of deferred asset ${asset.path}`)
        }
        await fs.writeBytes(joinUri(active.directory, requireStorablePath(asset.path)), bytes)
      }
    })
  }
  return (hostKey, buildId, fetch, scope = '') => {
    const key = `${hostKey}/${buildId}/${scope}`
    const running =
      filling.get(key) ??
      fill(hostKey, buildId, fetch).finally(() => {
        filling.delete(key)
      })
    filling.set(key, running)
    return running
  }
}

async function isExactly(asset: MobileWebBundleAssetRead, bytes: Uint8Array): Promise<boolean> {
  if (bytes.byteLength !== asset.byteLength) {
    return false
  }
  const hashed = new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes)))
  return Array.from(hashed, (byte) => byte.toString(16).padStart(2, '0')).join('') === asset.sha256
}

// Match by content, not build: a desktop that moved on to a newer build usually still serves the same engine.
export async function fetchDeferredAssetsFromDesktop(
  client: RpcClient,
  missing: readonly MobileWebBundleAssetRead[]
): Promise<ReadonlyMap<string, Uint8Array>> {
  const opened = await runRpcOperation(client, mobileWebBundleManifestRead, null)
  const only = missing.map((asset) => {
    const served = opened.manifest.assets.find(
      (entry) => entry.sha256 === asset.sha256 && entry.byteLength === asset.byteLength
    )
    if (served === undefined) {
      throw new Error(`the desktop no longer serves deferred asset ${asset.path}`)
    }
    return served
  })
  // The fetch hashes every asset against the entry it read, so each copy is the bytes this build lists.
  const fetched = await fetchMobileWebBundle({ client, opened, only })
  return new Map(
    only.flatMap((entry) => {
      const bytes = fetched.assets.get(entry.path)
      return bytes === undefined ? [] : [[entry.sha256, bytes] as const]
    })
  )
}
