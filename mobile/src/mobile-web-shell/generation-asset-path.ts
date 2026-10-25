/** The activation's manifest: a generation directory is an activation only once this is in it. */
export const MANIFEST_FILE_NAME = 'manifest.json'

/** The manifest schema bans traversal already, but this is the last code between a manifest and a
 *  write, and both manifest names are the store's own rather than an asset's to take: the pending
 *  one would be read back as an activation. Folded, because APFS and NTFS are case-insensitive and
 *  `Manifest.JSON` would land on the same file. */
export function requireStorablePath(path: string): string {
  const segments = path.split('/')
  const folded = path.toLowerCase()
  const storable =
    path.length > 0 &&
    folded !== MANIFEST_FILE_NAME &&
    !path.includes('\\') &&
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  if (!storable) {
    throw new Error(`generation store refuses to stage the asset path ${path}`)
  }
  return path
}
