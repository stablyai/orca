// Why: `Number("1e10")` succeeds and passes `Number.isInteger`, so a Ghostty
// config with `window-padding-x = 1e9` would sail through the mapper and land
// an absurd value in the store. Restrict to plain decimal integers.
const STRICT_INT_RE = /^-?\d+$/
export const parseStrictInt = (v: string): number | null => {
  if (!STRICT_INT_RE.test(v)) {
    return null
  }
  const num = Number(v)
  return Number.isFinite(num) ? num : null
}

// Why: Ghostty accepts "top,bottom" / "left,right" pairs for window paddings,
// but Orca stores a single value per axis — average the pair so the total
// padding along the axis stays the same.
export const parsePaddingValue = (v: string): number | null => {
  const parts = v.split(',')
  if (parts.length > 2) {
    return null
  }
  const nums: number[] = []
  for (const part of parts) {
    const num = parseStrictInt(part.trim())
    if (num === null || num < 0 || num > 512) {
      return null
    }
    nums.push(num)
  }
  return nums.reduce((sum, num) => sum + num, 0) / nums.length
}
