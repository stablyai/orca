// Reject exponent notation: Number.isInteger also accepts values such as 1e10.
const STRICT_INT_RE = /^-?\d+$/
export const parseStrictInt = (v: string): number | null => {
  if (!STRICT_INT_RE.test(v)) {
    return null
  }
  const num = Number(v)
  return Number.isFinite(num) ? num : null
}

// Average paired padding values to preserve total padding with Orca's symmetric per-axis setting.
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
