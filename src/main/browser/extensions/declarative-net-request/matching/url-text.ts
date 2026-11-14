import type { DnrUrlText } from './url-pattern'

// url::kMaxURLChars: url_pattern_index skips longer URLs entirely.
const MAX_URL_CHARS = 2 * 1024 * 1024

/**
 * Locates the host inside an already canonical URL spec (Electron hands webRequest listeners
 * GURL's spec). The spec itself is matched as-is so filters see exactly what Chromium sees.
 */
export function dnrUrlText(spec: string): DnrUrlText | null {
  if (spec.length > MAX_URL_CHARS) {
    return null
  }
  const colon = spec.indexOf(':')
  if (colon <= 0) {
    return null
  }
  let hostBegin = 0
  let hostEnd = 0
  if (spec.startsWith('//', colon + 1)) {
    const authorityBegin = colon + 3
    let authorityEnd = spec.length
    for (let i = authorityBegin; i < spec.length; i++) {
      const c = spec.charCodeAt(i)
      // '/', '?', '#', '\\'
      if (c === 47 || c === 63 || c === 35 || c === 92) {
        authorityEnd = i
        break
      }
    }
    const at = spec.lastIndexOf('@', authorityEnd - 1)
    hostBegin = at >= authorityBegin ? at + 1 : authorityBegin
    hostEnd = authorityEnd
    if (spec.charCodeAt(hostBegin) === 91) {
      const close = spec.indexOf(']', hostBegin)
      hostEnd = close !== -1 && close < authorityEnd ? close + 1 : authorityEnd
    } else {
      const port = spec.indexOf(':', hostBegin)
      if (port !== -1 && port < authorityEnd) {
        hostEnd = port
      }
    }
  }
  return { spec, lowerSpec: toLowerAscii(spec), hostBegin, hostEnd }
}

/** base::IsStringASCII. */
export function isAsciiText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) {
      return false
    }
  }
  return true
}

/** base::ToLowerASCII: only A-Z change, so offsets into the spec stay valid. */
export function toLowerAscii(text: string): string {
  return isAsciiText(text)
    ? text.toLowerCase()
    : text.replace(/[A-Z]+/g, (run) => run.toLowerCase())
}

export function dnrUrlHost(url: DnrUrlText): string {
  return url.spec.slice(url.hostBegin, url.hostEnd)
}

/**
 * For callers holding user-typed URLs (testMatchOutcome): WHATWG serialisation is the closest
 * pure-JS stand-in for GURL canonicalisation. Returns null for unparsable input.
 */
export function canonicalizeDnrUrl(raw: string): string | null {
  try {
    return new URL(raw).href
  } catch {
    return null
  }
}
