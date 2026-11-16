// Store split identifier terms separately so queries can match part of a symbol or path.

const RAW_TOKEN = /[A-Za-z0-9_./-]+/g
const CAMEL_PIECE = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g
const SEPARATOR = /[_./-]+/
const INTERESTING = /[_./-]|[a-z0-9][A-Z]|^[A-Z]{2,}[0-9_]*$/
const MIN_TOKEN = 3
const MAX_TOKEN = 120
const MIN_PIECE = 2

function hasMixedCase(piece: string): boolean {
  return /[a-z]/.test(piece) && /[A-Z]/.test(piece)
}

export function identifierShadowTerms(text: string, limit = 4000): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(RAW_TOKEN)) {
    const token = match[0]
    if (token.length < MIN_TOKEN || token.length > MAX_TOKEN || !INTERESTING.test(token)) {
      continue
    }
    const parts: string[] = []
    for (const piece of token.split(SEPARATOR)) {
      if (!piece) {
        continue
      }
      parts.push(piece)
      if (hasMixedCase(piece)) {
        parts.push(...(piece.match(CAMEL_PIECE) ?? []))
      }
    }
    for (const part of parts) {
      const lowered = part.toLowerCase()
      if (lowered.length < MIN_PIECE || seen.has(lowered)) {
        continue
      }
      seen.add(lowered)
      out.push(lowered)
      if (out.length >= limit) {
        return out
      }
    }
  }
  return out
}

export function identifierShadowText(text: string, limit?: number): string {
  return identifierShadowTerms(text, limit).join(' ')
}
