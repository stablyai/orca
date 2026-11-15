/** Rename/copy origins are consumed rather than reported as records. */
export type PorcelainV1Record = {
  xy: string
  path: string
}

/** Parse raw NUL paths to avoid quoted-path mismatches; rename/copy records also consume an origin field. */
export function parsePorcelainV1Records(stdout: string): PorcelainV1Record[] {
  const fields = stdout.split('\0')
  const records: PorcelainV1Record[] = []

  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]
    // Ignore trailing empties and fields too short for XY<space><path>.
    if (field.length < 4) {
      continue
    }
    const xy = field.slice(0, 2)
    records.push({ xy, path: field.slice(3) })
    if (xy.includes('R') || xy.includes('C')) {
      index++
    }
  }

  return records
}
