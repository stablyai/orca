// One compiled piece of a glob segment (`*`, `?`, `[...]`, or a literal).
type SegmentToken =
  | { kind: 'any' }
  | { kind: 'char'; char: string }
  | { kind: 'star' }
  | { kind: 'class'; negated: boolean; chars: Set<string>; ranges: [string, string][] }

// Compiles one glob segment into an anchored case-sensitive matcher with the
// same segment semantics as `globSync`. Matching scans the tokens linearly
// instead of running a RegExp, so crafted entry names cannot trigger
// catastrophic backtracking. An invalid class (`[z-a]`) makes the segment
// unmatchable, like globSync returning nothing for that alternative.
export function compileSegmentMatcher(segment: string): (name: string) => boolean {
  const tokens: SegmentToken[] = []
  let valid = true
  let index = 0
  while (index < segment.length) {
    const char = segment[index]
    if (char === '*') {
      tokens.push({ kind: 'star' })
      index += 1
      continue
    }
    if (char === '?') {
      tokens.push({ kind: 'any' })
      index += 1
      continue
    }
    if (char === '[') {
      const closing = findCharClassEnd(segment, index)
      if (closing === undefined) {
        // Unterminated class: globSync treats the bracket as a literal too.
        tokens.push({ kind: 'char', char })
        index += 1
        continue
      }
      if (!appendCharClassTokens(tokens, segment.slice(index + 1, closing))) {
        valid = false
      }
      index = closing + 1
      continue
    }
    tokens.push({ kind: 'char', char })
    index += 1
  }
  if (!valid) {
    return () => false
  }
  return (name) => matchSegmentTokens(tokens, name)
}

// Appends one `[...]` body's membership; returns false on an invalid range
// (`[z-a]`), which globSync treats as "this alternative matches nothing".
function appendCharClassTokens(tokens: SegmentToken[], body: string): boolean {
  let negated = false
  if (body.startsWith('!') || body.startsWith('^')) {
    // globSync negates on a leading `!` or `^`.
    negated = true
    body = body.slice(1)
  }
  const chars = new Set<string>()
  const ranges: [string, string][] = []
  let index = 0
  while (index < body.length) {
    if (body[index + 1] === '-' && index + 2 < body.length) {
      const low = body[index]
      const high = body[index + 2]
      if (low > high) {
        return false
      }
      ranges.push([low, high])
      index += 3
      continue
    }
    chars.add(body[index])
    index += 1
  }
  tokens.push({ kind: 'class', negated, chars, ranges })
  return true
}

function tokenMatchesChar(token: SegmentToken, char: string): boolean {
  if (token.kind === 'any') {
    return true
  }
  if (token.kind === 'char') {
    return token.char === char
  }
  if (token.kind === 'class') {
    const inside =
      token.chars.has(char) || token.ranges.some(([low, high]) => char >= low && char <= high)
    return token.negated ? !inside : inside
  }
  return false
}

// Greedy two-pointer wildcard match: O(name x tokens), no RegExp backtracking.
function matchSegmentTokens(tokens: readonly SegmentToken[], name: string): boolean {
  let nameIndex = 0
  let tokenIndex = 0
  let starTokenIndex = -1
  let starNameIndex = 0
  while (nameIndex < name.length) {
    const token = tokens[tokenIndex]
    if (token !== undefined && token.kind !== 'star' && tokenMatchesChar(token, name[nameIndex])) {
      nameIndex += 1
      tokenIndex += 1
      continue
    }
    if (token !== undefined && token.kind === 'star') {
      starTokenIndex = tokenIndex
      starNameIndex = nameIndex
      tokenIndex += 1
      continue
    }
    if (starTokenIndex === -1) {
      return false
    }
    starNameIndex += 1
    nameIndex = starNameIndex
    tokenIndex = starTokenIndex + 1
  }
  while (tokens[tokenIndex]?.kind === 'star') {
    tokenIndex += 1
  }
  return tokenIndex === tokens.length
}

function findCharClassEnd(segment: string, open: number): number | undefined {
  let index = open + 1
  // A leading `!`, `^`, or `]` belongs to the class header, not its members.
  if (segment[index] === '!' || segment[index] === '^' || segment[index] === ']') {
    index += 1
  }
  while (index < segment.length) {
    if (segment[index] === ']') {
      return index
    }
    index += 1
  }
  return undefined
}
