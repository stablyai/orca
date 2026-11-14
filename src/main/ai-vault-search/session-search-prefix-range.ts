/** An empty result means this prefix has no finite upper bound. */
export function sessionSearchPrefixUpperBound(prefix: string): string {
  const points = Array.from(prefix)
  while (points.length) {
    const point = points.pop()!.codePointAt(0)!
    if (point < 0x10ffff) {
      return points.join('') + String.fromCodePoint(point === 0xd7ff ? 0xe000 : point + 1)
    }
  }
  return ''
}
