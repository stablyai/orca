// Match trailing agent directory-listing size tokens (1.4K, 738B, 45.9M, …).
// Visual-only consumers use this to dim the token; the PTY buffer stays intact.

const SIZE_TOKEN_RE = /(\d+(?:\.\d+)?)([KMGT]B?|B)\s*$/i

export type DirListingSizeRange = {
  readonly start: number
  readonly end: number
  readonly token: string
}

/**
 * Returns the string range of a trailing size token when the line looks like a
 * directory listing entry (`name  1.4K`). Narrow by design: requires a non-space
 * prefix (the filename) and end-of-line placement.
 */
export function matchTrailingDirListingSize(lineText: string): DirListingSizeRange | null {
  if (!lineText) {
    return null
  }
  const match = SIZE_TOKEN_RE.exec(lineText)
  if (!match || match.index === undefined) {
    return null
  }
  const tokenStart = match.index
  if (tokenStart === 0) {
    return null
  }
  // Why: size must be separated from the name; "file1.4K" is not a listing token.
  if (!/\s/.test(lineText.charAt(tokenStart - 1))) {
    return null
  }
  let prefixEnd = tokenStart
  while (prefixEnd > 0 && /\s/.test(lineText.charAt(prefixEnd - 1))) {
    prefixEnd -= 1
  }
  if (prefixEnd === 0) {
    return null
  }
  const token = match[1]! + match[2]!
  return { start: tokenStart, end: tokenStart + token.length, token }
}
