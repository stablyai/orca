type GlobSegmentToken =
  | { kind: 'star' }
  | { kind: 'any' }
  | { kind: 'char'; value: string }
  | { kind: 'class'; negated: boolean; chars: Set<string>; ranges: [string, string][] }

export function normalizePiSkillPattern(pattern: string): string {
  return pattern.trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, '')
}

function tokenizeGlobSegment(segment: string): GlobSegmentToken[] {
  const tokens: GlobSegmentToken[] = []
  let i = 0
  while (i < segment.length) {
    const ch = segment[i]
    if (ch === '*') {
      if (tokens.at(-1)?.kind !== 'star') {
        tokens.push({ kind: 'star' })
      }
      i++
      continue
    }
    if (ch === '?') {
      tokens.push({ kind: 'any' })
      i++
      continue
    }
    if (ch === '[') {
      const closeIndex = segment.indexOf(']', i + 1)
      if (closeIndex > i + 1) {
        const body = segment.slice(i + 1, closeIndex)
        const negated = body.startsWith('!') || body.startsWith('^')
        const content = negated ? body.slice(1) : body
        if (content.length > 0) {
          const chars = new Set<string>()
          const ranges: [string, string][] = []
          let valid = true
          for (let j = 0; j < content.length; j++) {
            if (j + 2 < content.length && content[j + 1] === '-') {
              const lo = content[j]
              const hi = content[j + 2]
              if (lo > hi) {
                valid = false
                break
              }
              ranges.push([lo, hi])
              j += 2
            } else {
              chars.add(content[j])
            }
          }
          if (valid) {
            tokens.push({ kind: 'class', negated, chars, ranges })
            i = closeIndex + 1
            continue
          }
        }
      }
    }
    tokens.push({ kind: 'char', value: ch })
    i++
  }
  return tokens
}

function matchGlobToken(token: GlobSegmentToken, ch: string): boolean {
  switch (token.kind) {
    case 'any':
      return true
    case 'char':
      return token.value === ch
    case 'class': {
      const inSet = token.chars.has(ch) || token.ranges.some(([lo, hi]) => ch >= lo && ch <= hi)
      return token.negated ? !inSet : inSet
    }
    case 'star':
      return false
  }
}

function matchGlobSegment(pattern: string, target: string): boolean {
  const tokens = tokenizeGlobSegment(pattern)
  let pi = 0
  let ti = 0
  let starPi = -1
  let starTi = 0
  while (ti < target.length) {
    if (pi < tokens.length && tokens[pi].kind === 'star') {
      starPi = pi++
      starTi = ti
    } else if (pi < tokens.length && matchGlobToken(tokens[pi], target[ti])) {
      pi++
      ti++
    } else if (starPi !== -1) {
      pi = starPi + 1
      ti = ++starTi
    } else {
      return false
    }
  }
  while (pi < tokens.length && tokens[pi].kind === 'star') {
    pi++
  }
  return pi === tokens.length
}

export function matchesPiSkillGlob(pattern: string, target: string): boolean {
  const cleanPattern = normalizePiSkillPattern(pattern).toLowerCase()
  const cleanTarget = normalizePiSkillPattern(target).toLowerCase()
  const patternSegs = cleanPattern ? cleanPattern.split('/') : []
  const targetSegs = cleanTarget ? cleanTarget.split('/') : []
  let pi = 0
  let ti = 0
  let starPi = -1
  let starTi = 0
  while (ti < targetSegs.length) {
    if (pi < patternSegs.length && patternSegs[pi] === '**') {
      starPi = pi++
      starTi = ti
    } else if (pi < patternSegs.length && matchGlobSegment(patternSegs[pi], targetSegs[ti])) {
      pi++
      ti++
    } else if (starPi !== -1) {
      pi = starPi + 1
      ti = ++starTi
    } else {
      return false
    }
  }
  while (pi < patternSegs.length && patternSegs[pi] === '**') {
    pi++
  }
  return pi === patternSegs.length
}

export function matchesPiSkillPattern(relPath: string, patterns: readonly string[]): boolean {
  const normalized = normalizePiSkillPattern(relPath)
  return patterns.some((pattern) => {
    const raw = normalizePiSkillPattern(pattern)
    if (!raw) {
      return false
    }
    const clean = raw.replace(/(?:^|\/)SKILL\.md$/i, '')
    if (!clean) {
      return normalized === ''
    }
    return matchesPiSkillGlob(clean, normalized) || matchesPiSkillGlob(`${clean}/**`, normalized)
  })
}

export function hasNestedPiExclusion(rel: string, exclusion: string): boolean {
  const cleanEx = normalizePiSkillPattern(exclusion).replace(/(?:^|\/)SKILL\.md$/i, '')
  if (!cleanEx) {
    return false
  }
  if (!rel || cleanEx.includes('**')) {
    return true
  }
  const relParts = rel.split('/')
  const exParts = cleanEx.split('/')
  if (exParts.length <= relParts.length) {
    return false
  }
  return matchesPiSkillGlob(exParts.slice(0, relParts.length).join('/'), rel)
}
