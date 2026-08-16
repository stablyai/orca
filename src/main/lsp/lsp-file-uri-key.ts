/** Canonical map key for a file:// URI. Servers mint their own URI form —
 *  vscode-uri lowercases drive letters and percent-encodes ':' where Node's
 *  pathToFileURL does not — so exact-string matching drops their messages.
 *  Decode, then fold the drive letter, so both forms land on one key. */
export function canonicalFileUriKey(uri: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(uri)
  } catch {
    decoded = uri
  }
  return decoded.replace(
    /^(file:\/\/\/)([A-Za-z])(:)/,
    (_match, prefix: string, drive: string, colon: string) =>
      `${prefix}${drive.toLowerCase()}${colon}`
  )
}
