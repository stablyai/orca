/** One `git status --porcelain -z` record: the two-letter status code and the
 *  path it applies to. Rename/copy origins are consumed, not reported. */
export type PorcelainV1Record = {
  xy: string
  path: string
}

/** Parse `git status --porcelain -z` (v1) into records.
 *
 *  Why `-z` and a real parser rather than splitting lines: without `-z` Git
 *  quotes and escapes paths containing spaces, quotes, or non-ASCII bytes, so a
 *  path comparison against a configured entry would silently miss. With `-z`
 *  paths are raw, but a rename or copy emits its origin as a *second*
 *  NUL-separated field — treating that origin as its own record would invent a
 *  status code out of the leading bytes of a path. */
export function parsePorcelainV1Records(stdout: string): PorcelainV1Record[] {
  const fields = stdout.split('\0')
  const records: PorcelainV1Record[] = []

  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]
    // Why: the trailing NUL yields a final empty field; a record is always
    // `XY<space><path>`, so anything shorter cannot be one.
    if (field.length < 4) {
      continue
    }
    const xy = field.slice(0, 2)
    records.push({ xy, path: field.slice(3) })
    if (xy.includes('R') || xy.includes('C')) {
      // Skip the origin path that follows a rename or copy.
      index++
    }
  }

  return records
}
