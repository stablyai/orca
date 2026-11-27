export type ScreenNotchGeometry = {
  displayId: number
  safeAreaTop: number
  notchLeadingOffsetX: number | null
  notchTrailingOffsetX: number | null
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function parseScreenGeometry(stdout: string): Map<number, ScreenNotchGeometry> {
  const result = new Map<number, ScreenNotchGeometry>()
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return result
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('displays' in parsed) ||
    !Array.isArray(parsed.displays)
  ) {
    return result
  }
  for (const row of parsed.displays) {
    if (!row || typeof row !== 'object' || !('displayId' in row) || !('safeAreaTop' in row)) {
      continue
    }
    const entry = row
    if (
      !finite(entry.displayId) ||
      !Number.isInteger(entry.displayId) ||
      !finite(entry.safeAreaTop) ||
      entry.safeAreaTop < 0
    ) {
      continue
    }
    const leading = 'notchLeadingOffsetX' in entry ? entry.notchLeadingOffsetX : null
    const trailing = 'notchTrailingOffsetX' in entry ? entry.notchTrailingOffsetX : null
    const validCutout = finite(leading) && finite(trailing) && leading >= 0 && trailing > leading
    result.set(entry.displayId, {
      displayId: entry.displayId,
      safeAreaTop: entry.safeAreaTop,
      notchLeadingOffsetX: validCutout ? leading : null,
      notchTrailingOffsetX: validCutout ? trailing : null
    })
  }
  return result
}
