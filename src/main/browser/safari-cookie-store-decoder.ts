const MAC_EPOCH_DELTA_SECONDS = 978_307_200

export const SAFARI_COOKIE_STORE_MAX_FILE_BYTES = 64 * 1024 * 1024
export const SAFARI_COOKIE_STORE_MAX_PAGES = 65_536
export const SAFARI_COOKIE_STORE_MAX_COOKIES = 250_000
export const SAFARI_COOKIE_STORE_MAX_PARSED_BYTES = 64 * 1024 * 1024

export type SafariCookieStoreLimitKind = 'pages' | 'cookies' | 'parsed-bytes'

export class SafariCookieStoreLimitError extends Error {
  constructor(
    readonly kind: SafariCookieStoreLimitKind,
    readonly observed: number,
    readonly limit: number
  ) {
    super(`Safari cookie store exceeds the ${kind} limit`)
    this.name = 'SafariCookieStoreLimitError'
  }
}

export type SafariDecodedCookie = {
  url: string
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'unspecified'
  expirationDate: number | undefined
}

export type SafariCookieDecodeResult = {
  cookies: SafariDecodedCookie[]
  totalCookies: number
}

export type SafariCookieDecodeLimits = {
  maxPages: number
  maxCookies: number
  maxParsedBytes: number
}

const DEFAULT_LIMITS: SafariCookieDecodeLimits = {
  maxPages: SAFARI_COOKIE_STORE_MAX_PAGES,
  maxCookies: SAFARI_COOKIE_STORE_MAX_COOKIES,
  maxParsedBytes: SAFARI_COOKIE_STORE_MAX_PARSED_BYTES
}

type DecodeState = {
  readonly cookies: SafariDecodedCookie[]
  readonly limits: SafariCookieDecodeLimits
  decodedCookies: number
  inspectedEntries: number
  parsedBytes: number
}

export function decodeSafariCookieStore(
  buffer: Buffer,
  limits: SafariCookieDecodeLimits = DEFAULT_LIMITS
): SafariCookieDecodeResult {
  if (buffer.length < 8 || buffer.subarray(0, 4).toString('utf8') !== 'cook') {
    return { cookies: [], totalCookies: 0 }
  }

  const pageCount = buffer.readUInt32BE(4)
  enforceLimit('pages', pageCount, limits.maxPages)
  const pagesOffset = 8 + pageCount * 4
  if (pagesOffset > buffer.length) {
    return { cookies: [], totalCookies: 0 }
  }

  const state: DecodeState = {
    cookies: [],
    limits,
    decodedCookies: 0,
    inspectedEntries: 0,
    parsedBytes: 0
  }
  let pageOffset = pagesOffset
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageSize = buffer.readUInt32BE(8 + pageIndex * 4)
    const pageEnd = Math.min(buffer.length, pageOffset + pageSize)
    decodeSafariCookiePage(buffer.subarray(pageOffset, pageEnd), state)
    pageOffset += pageSize
  }
  return { cookies: state.cookies, totalCookies: state.decodedCookies }
}

function decodeSafariCookiePage(page: Buffer, state: DecodeState): void {
  if (page.length < 16 || page.readUInt32BE(0) !== 0x00000100) {
    return
  }

  const cookieCount = page.readUInt32LE(4)
  state.inspectedEntries += cookieCount
  enforceLimit('cookies', state.inspectedEntries, state.limits.maxCookies)
  if (8 + cookieCount * 4 > page.length) {
    return
  }

  for (let index = 0; index < cookieCount; index += 1) {
    const offset = page.readUInt32LE(8 + index * 4)
    const cookie = decodeSafariCookie(page.subarray(offset))
    if (!cookie) {
      continue
    }
    state.decodedCookies += 1
    state.parsedBytes += cookieRetainedBytes(cookie)
    enforceLimit('parsed-bytes', state.parsedBytes, state.limits.maxParsedBytes)
    state.cookies.push(cookie)
  }
}

export function removeExpiredSafariCookiesInPlace(
  cookies: SafariDecodedCookie[],
  nowSeconds: number
): void {
  let retained = 0
  for (const cookie of cookies) {
    if (!cookie.expirationDate || cookie.expirationDate > nowSeconds) {
      cookies[retained] = cookie
      retained += 1
    }
  }
  cookies.length = retained
}

function decodeSafariCookie(buffer: Buffer): SafariDecodedCookie | null {
  if (buffer.length < 48) {
    return null
  }
  // Why: the declared size is external; clamp string scans to bytes present in this page.
  const size = Math.min(buffer.readUInt32LE(0), buffer.length)
  if (size < 48) {
    return null
  }

  const flags = buffer.readUInt32LE(8)
  const secure = (flags & 1) !== 0
  const name = readCString(buffer, buffer.readUInt32LE(20), size)
  if (!name) {
    return null
  }
  const value = readCString(buffer, buffer.readUInt32LE(28), size) ?? ''
  const path = readCString(buffer, buffer.readUInt32LE(24), size) ?? '/'
  const rawUrl = readCString(buffer, buffer.readUInt32LE(16), size) ?? ''
  const domain = rawUrl.startsWith('.') ? rawUrl : rawUrl || null
  if (!domain) {
    return null
  }

  const url = deriveUrl(domain, secure)
  if (!url) {
    return null
  }
  // Why: Safari stores expiration seconds relative to 2001-01-01.
  const expiration = buffer.readDoubleLE(40)
  const expirationDate =
    expiration > 0 ? Math.round(expiration + MAC_EPOCH_DELTA_SECONDS) : undefined

  return {
    url,
    name,
    value,
    domain,
    path,
    secure,
    httpOnly: (flags & 4) !== 0,
    sameSite: 'unspecified',
    expirationDate
  }
}

function readCString(buffer: Buffer, offset: number, end: number): string | null {
  if (offset < 0 || offset >= end) {
    return null
  }
  let cursor = offset
  while (cursor < end && buffer[cursor] !== 0) {
    cursor += 1
  }
  return cursor < end ? buffer.toString('utf8', offset, cursor) : null
}

function deriveUrl(domain: string, secure: boolean): string | null {
  const cleanDomain = domain.startsWith('.') ? domain.slice(1) : domain
  if (!cleanDomain || cleanDomain.includes(' ')) {
    return null
  }
  try {
    return new URL(`${secure ? 'https' : 'http'}://${cleanDomain}/`).toString()
  } catch {
    return null
  }
}

function cookieRetainedBytes(cookie: SafariDecodedCookie): number {
  return (
    Buffer.byteLength(cookie.url) +
    Buffer.byteLength(cookie.name) +
    Buffer.byteLength(cookie.value) +
    Buffer.byteLength(cookie.domain) +
    Buffer.byteLength(cookie.path)
  )
}

function enforceLimit(kind: SafariCookieStoreLimitKind, observed: number, limit: number): void {
  if (observed > limit) {
    throw new SafariCookieStoreLimitError(kind, observed, limit)
  }
}
