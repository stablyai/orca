/** `segments` without repeats, first one kept, compared by `pathKey`. */
export function uniquePathSegments(
  segments: string[],
  pathKey: (segment: string) => string
): string[] {
  const seen = new Set<string>()
  return segments.filter((segment) => {
    const key = pathKey(segment)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}
