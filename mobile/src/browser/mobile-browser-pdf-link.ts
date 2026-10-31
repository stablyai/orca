// Only http(s) PDFs the phone can fetch itself; a desktop-local URL would open the wrong document.
export function isExternallyOpenablePdfUrl(rawUrl: string): boolean {
  const url = parseHttpUrl(rawUrl)
  if (!url || isLoopbackHost(url.host)) {
    return false
  }
  try {
    const pathname = decodeURIComponent(url.pathname).replace(/\/$/, '')
    return /\.pdf$/i.test(pathname)
  } catch {
    return false
  }
}

type ParsedHttpUrl = { host: string; pathname: string }

// React Native's URL class appends a slash to bare paths and misreads IPv6 hosts, so parse the raw value.
function parseHttpUrl(rawUrl: string): ParsedHttpUrl | null {
  const match = /^https?:\/\/([^/?#]*)([^?#]*)/i.exec(rawUrl)
  if (!match) {
    return null
  }
  let authority = match[1]!
  if (authority.includes('\\')) {
    return null
  }
  const userInfo = authority.lastIndexOf('@')
  if (userInfo >= 0) {
    authority = authority.slice(userInfo + 1)
  }
  if (!authority) {
    return null
  }
  let host = authority
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']')
    if (close < 0) {
      return null
    }
    host = authority.slice(0, close + 1)
  } else {
    const port = authority.indexOf(':')
    if (port >= 0) {
      host = authority.slice(0, port)
    }
  }
  return { host, pathname: match[2] || '/' }
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host)
  if (normalized === null) {
    return true
  }
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return true
  }
  const ipv4 = parseIpv4(normalized)
  if (ipv4) {
    return ipv4[0] === 127 || ipv4[0] === 0
  }
  const ipv6 = parseIpv6(normalized)
  if (!ipv6) {
    return false
  }
  if (ipv6[7] === 1 && ipv6.slice(0, 7).every((group) => group === 0)) {
    return true
  }
  if (ipv6.slice(0, 5).every((group) => group === 0) && (ipv6[5] === 0 || ipv6[5] === 0xffff)) {
    const firstOctet = ipv6[6]! >> 8
    return firstOctet === 127 || firstOctet === 0
  }
  return false
}

function normalizeHost(host: string): string | null {
  let normalized = host.toLowerCase()
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1)
  }
  try {
    normalized = decodeURIComponent(normalized)
  } catch {
    return null
  }
  if (normalized.includes('\\')) {
    return null
  }
  return normalized.replace(/\.$/, '')
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length < 1 || parts.length > 4) {
    return null
  }
  const values: number[] = []
  for (const part of parts) {
    let digits = part
    let radix = 10
    if (/^0x/i.test(part)) {
      digits = part.slice(2)
      radix = 16
    } else if (part.length > 1 && part.startsWith('0')) {
      digits = part.slice(1)
      radix = 8
    }
    const pattern = radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : /^\d+$/
    if (!digits || !pattern.test(digits)) {
      return null
    }
    const value = Number.parseInt(digits, radix)
    if (!Number.isSafeInteger(value)) {
      return null
    }
    values.push(value)
  }
  const last = values[values.length - 1]!
  if (values.slice(0, -1).some((value) => value > 255) || last >= 256 ** (5 - values.length)) {
    return null
  }
  let address = last
  for (let index = 0; index < values.length - 1; index += 1) {
    address += values[index]! * 256 ** (3 - index)
  }
  return [
    Math.floor(address / 256 ** 3) % 256,
    Math.floor(address / 256 ** 2) % 256,
    Math.floor(address / 256) % 256,
    address % 256
  ]
}

function parseIpv6(host: string): number[] | null {
  const halves = host.split('%')[0]!.split('::')
  if (halves.length > 2) {
    return null
  }
  const left = parseIpv6Groups(halves[0] ?? '')
  if (!left) {
    return null
  }
  if (halves.length === 1) {
    return left.length === 8 ? left : null
  }
  const right = parseIpv6Groups(halves[1] ?? '')
  if (!right) {
    return null
  }
  const missing = 8 - left.length - right.length
  return missing < 0 ? null : [...left, ...new Array<number>(missing).fill(0), ...right]
}

function parseIpv6Groups(value: string): number[] | null {
  const groups: number[] = []
  for (const part of value.split(':')) {
    if (!part) {
      continue
    }
    if (part.includes('.')) {
      const ipv4 = parseIpv4(part)
      if (!ipv4) {
        return null
      }
      groups.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!)
    } else if (/^[0-9a-f]{1,4}$/.test(part)) {
      groups.push(parseInt(part, 16))
    } else {
      return null
    }
  }
  return groups
}
