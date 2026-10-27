// A generation activates only once its manifest exists.
export const MANIFEST_FILE_NAME = 'manifest.json'

// Recheck traversal at the write boundary and reserve both manifest names; fold case because APFS/NTFS can alias Manifest.JSON to manifest.json.
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
