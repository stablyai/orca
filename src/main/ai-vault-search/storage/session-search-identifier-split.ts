// Store split identifier terms separately so queries can match part of a symbol or path.

const RAW_TOKEN = /[A-Za-z0-9_./-]+/g
const CAMEL_PIECE = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g
const INTERESTING = /[_./-]|[a-z0-9][A-Z]|^[A-Z]{2,}[0-9_]*$/
const MIN_TOKEN = 3
const MAX_TOKEN = 120
const MIN_PIECE = 2

function isSeparatorCode(code: number): boolean {
  // '_', '.', '/', '-'
  return code === 95 || code === 46 || code === 47 || code === 45
}

function hasMixedCase(piece: string): boolean {
  let hasLower = false
  let hasUpper = false
  for (let i = 0; i < piece.length; i += 1) {
    const code = piece.charCodeAt(i)
    if (code >= 97 && code <= 122) {
      if (hasUpper) {
        return true
      }
      hasLower = true
    } else if (code >= 65 && code <= 90) {
      if (hasLower) {
        return true
      }
      hasUpper = true
    }
  }
  return false
}

function emitTerm(part: string, seen: Set<string>, out: string[], limit: number): boolean {
  if (part.length < MIN_PIECE) {
    return false
  }
  const lowered = part.toLowerCase()
  if (seen.has(lowered)) {
    return false
  }
  seen.add(lowered)
  out.push(lowered)
  return out.length >= limit
}

export function identifierShadowTerms(text: string, limit = 4000): string[] {
  if (text.length < MIN_TOKEN || limit <= 0) {
    return []
  }
  const out: string[] = []
  const seen = new Set<string>()
  RAW_TOKEN.lastIndex = 0
  let rawMatch: RegExpExecArray | null
  while ((rawMatch = RAW_TOKEN.exec(text)) !== null) {
    const token = rawMatch[0]
    if (token.length < MIN_TOKEN || token.length > MAX_TOKEN || !INTERESTING.test(token)) {
      continue
    }
    let start = 0
    const tokenLength = token.length
    while (start < tokenLength) {
      while (start < tokenLength && isSeparatorCode(token.charCodeAt(start))) {
        start += 1
      }
      if (start >= tokenLength) {
        break
      }
      let end = start + 1
      while (end < tokenLength && !isSeparatorCode(token.charCodeAt(end))) {
        end += 1
      }
      const piece = start === 0 && end === tokenLength ? token : token.slice(start, end)
      start = end
      if (emitTerm(piece, seen, out, limit)) {
        return out
      }
      if (hasMixedCase(piece)) {
        CAMEL_PIECE.lastIndex = 0
        let camelMatch: RegExpExecArray | null
        while ((camelMatch = CAMEL_PIECE.exec(piece)) !== null) {
          if (emitTerm(camelMatch[0], seen, out, limit)) {
            return out
          }
        }
      }
    }
  }
  return out
}

export function identifierShadowText(text: string, limit?: number): string {
  if (text.length < MIN_TOKEN || (limit !== undefined && limit <= 0)) {
    return ''
  }
  return identifierShadowTerms(text, limit).join(' ')
}
