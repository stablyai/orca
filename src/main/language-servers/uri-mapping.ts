// Native host path <-> LSP `file:` URI (spec D5). The mapping table lives in
// the process that owns the execution host — for S1 that is the native spawn
// adapter only; WSL (UNC⇄guest) and SSH (POSIX + connectionId) join this table
// in later slices.
import {
  isWindowsNativePath,
  normalizeNativeFilePath
} from '../../shared/language-server-path-normalization'

export { normalizeNativeFilePath }

/** `D:\a b\c.cpp` -> `file:///D:/a%20b/c.cpp`; `/home/x/a.cpp` -> `file:///home/x/a.cpp`. */
export function nativePathToLspUri(nativePath: string): string {
  const key = normalizeNativeFilePath(nativePath)
  const forward = key.replace(/\\/g, '/')
  const encoded = encodeURI(forward).replace(
    /[?#]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
  // Windows drive paths sit after the third slash (`file:///D:/…`); POSIX
  // absolute paths already carry their own leading slash (`file:///home/…`).
  return `file://${isWindowsNativePath(key) ? '/' : ''}${encoded}`
}

/** `file:///D:/x/y` (any drive case, %XX escapes) -> `D:\x\y`, uppercase drive. */
export function lspUriToNativePath(uri: string): string {
  const match = /^file:\/\/\/(.+)$/.exec(uri)
  if (!match) {
    throw new Error(`not a native file: URI: ${uri}`)
  }
  const decoded = decodeURIComponent(match[1])
  if (!isWindowsNativePath(decoded)) {
    return `/${decoded.replace(/\\/g, '/')}`
  }
  return normalizeNativeFilePath(decoded.replace(/\//g, '\\'))
}
