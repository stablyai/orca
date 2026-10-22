import { isHostCacheKey } from './host-cache-key'

export function requireHostKey(hostKey: string): string {
  if (!isHostCacheKey(hostKey)) {
    throw new Error('generation store was handed something that is not a host cache key')
  }
  return hostKey
}

/** The manifest schema bans traversal already, but this is the last code between a manifest and a
 *  write, and both manifest names are the store's own rather than an asset's to take: the pending
 *  one would be read back as an activation. Folded, because APFS and NTFS are case-insensitive and
 *  `Manifest.JSON` would land on the same file. */
export function requireStorablePath(path: string): string {
  const segments = path.split('/')
  const folded = path.toLowerCase()
  const storable =
    path.length > 0 &&
    folded !== 'manifest.json' &&
    !path.includes('\\') &&
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  if (!storable) {
    throw new Error(`generation store refuses to stage the asset path ${path}`)
  }
  return path
}

export function requireExactBytes(
  bytes: Uint8Array | undefined,
  asset: { path: string; byteLength: number }
): Uint8Array {
  // Only complete generations activate, so the check is before the first write rather than after
  // the last: a manifest asset that is absent or the wrong length never reaches disk.
  if (bytes === undefined || bytes.byteLength !== asset.byteLength) {
    throw new Error(
      `bundle asset ${asset.path} is ${bytes?.byteLength ?? 'absent'}, not the manifest's ${asset.byteLength}`
    )
  }
  return bytes
}
