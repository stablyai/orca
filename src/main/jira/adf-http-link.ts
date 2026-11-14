export type HttpLinkSpan = { start: number; end: number; url: string }

export const httpCharacterReader = { read: (value: string, index: number): string => value[index] }
const TRAILING = /^[!"&'),.:;<>?\]}*_~]$/

function normalize(value: string, start: number, end: number): HttpLinkSpan | null {
  const previous = start > 0 ? httpCharacterReader.read(value, start - 1) : ''
  const prefix = value.slice(start, start + 8).toLowerCase()
  const authorityStart =
    start + (prefix.startsWith('https://') ? 8 : prefix.startsWith('http://') ? 7 : 0)
  let authority = true
  let hostStart = authorityStart
  let inBracket = false
  let validIpv6 = false
  let ipv6Length = 0
  let protectedEnd = start
  let opens = 0
  let closes = 0
  for (let index = start; index < end; index++) {
    const char = httpCharacterReader.read(value, index)
    opens += char === '(' ? 1 : 0
    closes += char === ')' ? 1 : 0
    if (index < authorityStart || !authority) {
      continue
    }
    if (char === '/' || char === '?' || char === '#') {
      authority = false
    } else if (char === '@') {
      hostStart = index + 1
      inBracket = false
      protectedEnd = start
    } else if (index === hostStart && char === '[') {
      inBracket = true
      validIpv6 = true
      ipv6Length = 0
    } else if (inBracket && char === ']') {
      if (validIpv6 && ipv6Length > 0) {
        protectedEnd = index + 1
      }
      inBracket = false
    } else if (inBracket) {
      validIpv6 &&= /^[\da-fA-F:.]$/.test(char)
      ipv6Length++
    }
  }
  if (previous && !/[\s\p{P}]/u.test(previous)) {
    return null
  }
  let tailStart = end
  let tailCloses = 0
  while (tailStart > protectedEnd) {
    const char = httpCharacterReader.read(value, tailStart - 1)
    if (!TRAILING.test(char)) {
      break
    }
    tailCloses += char === ')' ? 1 : 0
    tailStart--
  }
  let balance = opens - (closes - tailCloses)
  let linkEnd = tailStart
  for (let index = tailStart; index < end && balance > 0; index++) {
    if (httpCharacterReader.read(value, index) === ')') {
      balance--
      linkEnd = index + 1
    }
  }
  if (linkEnd <= start) {
    return null
  }
  const label = value.slice(start, linkEnd)
  return { start, end: linkEnd, url: /^www\./i.test(label) ? `http://${label}` : label }
}

// Observe actual candidate admission and normalization reads in the production contract.
export const httpCandidateNormalizer = { normalize }
