import { describe, expect, it } from 'vitest'
import {
  decodeSafariCookieStore,
  SAFARI_COOKIE_STORE_MAX_COOKIES,
  SAFARI_COOKIE_STORE_MAX_FILE_BYTES,
  SAFARI_COOKIE_STORE_MAX_PAGES,
  SAFARI_COOKIE_STORE_MAX_PARSED_BYTES,
  SafariCookieStoreLimitError,
  removeExpiredSafariCookiesInPlace,
  type SafariCookieDecodeLimits
} from './safari-cookie-store-decoder'

type TestCookie = {
  domain: string
  name: string
  value: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  expiration?: number
}

function buildCookie(input: TestCookie): Buffer {
  const strings = [input.domain, input.name, input.path ?? '/', input.value]
  let cursor = 48
  const offsets = strings.map((text) => {
    const offset = cursor
    cursor += Buffer.byteLength(text) + 1
    return offset
  })
  const cookie = Buffer.alloc(cursor)
  cookie.writeUInt32LE(cookie.length, 0)
  cookie.writeUInt32LE((input.secure ? 1 : 0) | (input.httpOnly ? 4 : 0), 8)
  cookie.writeUInt32LE(offsets[0]!, 16)
  cookie.writeUInt32LE(offsets[1]!, 20)
  cookie.writeUInt32LE(offsets[2]!, 24)
  cookie.writeUInt32LE(offsets[3]!, 28)
  cookie.writeDoubleLE(input.expiration ?? 0, 40)
  strings.forEach((text, index) => cookie.write(text, offsets[index]!, 'utf8'))
  return cookie
}

function buildPage(inputs: TestCookie[]): Buffer {
  const cookies = inputs.map(buildCookie)
  const headerBytes = 8 + cookies.length * 4
  const page = Buffer.alloc(headerBytes + cookies.reduce((sum, cookie) => sum + cookie.length, 0))
  page.writeUInt32BE(0x00000100, 0)
  page.writeUInt32LE(cookies.length, 4)
  let cursor = headerBytes
  cookies.forEach((cookie, index) => {
    page.writeUInt32LE(cursor, 8 + index * 4)
    cookie.copy(page, cursor)
    cursor += cookie.length
  })
  return page
}

function buildStore(pages: TestCookie[][]): Buffer {
  const encodedPages = pages.map(buildPage)
  const headerBytes = 8 + encodedPages.length * 4
  const store = Buffer.alloc(headerBytes + encodedPages.reduce((sum, page) => sum + page.length, 0))
  store.write('cook', 0, 'utf8')
  store.writeUInt32BE(encodedPages.length, 4)
  let cursor = headerBytes
  encodedPages.forEach((page, index) => {
    store.writeUInt32BE(page.length, 8 + index * 4)
    page.copy(store, cursor)
    cursor += page.length
  })
  return store
}

function limits(overrides: Partial<SafariCookieDecodeLimits> = {}): SafariCookieDecodeLimits {
  return {
    maxPages: 10,
    maxCookies: 10,
    maxParsedBytes: 1024,
    ...overrides
  }
}

function retainedBytes(cookie: TestCookie): number {
  const cleanDomain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
  const url = `${cookie.secure ? 'https' : 'http'}://${cleanDomain}/`
  return [url, cookie.domain, cookie.name, cookie.value, cookie.path ?? '/'].reduce(
    (sum, value) => sum + Buffer.byteLength(value),
    0
  )
}

describe('decodeSafariCookieStore', () => {
  it('preserves page order and removes expired cookies without a second retained list', () => {
    const first = {
      domain: '.first.example.com',
      name: 'first',
      value: 'one',
      secure: true,
      httpOnly: true
    }
    const expired = {
      domain: '.expired.example.com',
      name: 'expired',
      value: 'old',
      expiration: 1
    }
    const last = { domain: '.last.example.com', name: 'last', value: 'three' }

    const result = decodeSafariCookieStore(buildStore([[first, expired], [last]]))
    const originalList = result.cookies
    removeExpiredSafariCookiesInPlace(result.cookies, 2_000_000_000)

    expect(result.totalCookies).toBe(3)
    expect(result.cookies).toBe(originalList)
    expect(result.cookies.map((cookie) => cookie.name)).toEqual(['first', 'last'])
    expect(result.cookies[0]).toMatchObject({
      url: 'https://first.example.com/',
      domain: '.first.example.com',
      value: 'one',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'unspecified'
    })
  })

  it('accepts the exact cookie and parsed-byte boundaries', () => {
    const first = { domain: '.a.example.com', name: 'a', value: 'one' }
    const second = { domain: '.b.example.com', name: 'b', value: 'two' }
    const maxParsedBytes = retainedBytes(first) + retainedBytes(second)

    const result = decodeSafariCookieStore(
      buildStore([[first, second]]),
      limits({ maxCookies: 2, maxParsedBytes })
    )

    expect(result.cookies.map((cookie) => cookie.name)).toEqual(['a', 'b'])
  })

  it('rejects one cookie or parsed byte over the configured boundary', () => {
    const first = { domain: '.a.example.com', name: 'a', value: 'one' }
    const second = { domain: '.b.example.com', name: 'b', value: 'two' }
    const store = buildStore([[first, second]])

    expect(() => decodeSafariCookieStore(store, limits({ maxCookies: 1 }))).toThrow(
      expect.objectContaining({ kind: 'cookies', observed: 2, limit: 1 })
    )
    expect(() =>
      decodeSafariCookieStore(
        store,
        limits({ maxParsedBytes: retainedBytes(first) + retainedBytes(second) - 1 })
      )
    ).toThrow(
      expect.objectContaining({
        kind: 'parsed-bytes',
        observed: retainedBytes(first) + retainedBytes(second)
      })
    )
  })

  it('counts malformed declared entries against the parse budget', () => {
    const malformedPage = Buffer.alloc(20)
    malformedPage.writeUInt32BE(0x00000100, 0)
    malformedPage.writeUInt32LE(3, 4)
    const header = Buffer.alloc(12)
    header.write('cook', 0, 'utf8')
    header.writeUInt32BE(1, 4)
    header.writeUInt32BE(malformedPage.length, 8)

    expect(() =>
      decodeSafariCookieStore(Buffer.concat([header, malformedPage]), limits({ maxCookies: 2 }))
    ).toThrow(SafariCookieStoreLimitError)
  })

  it('publishes generous production limits', () => {
    expect({
      fileBytes: SAFARI_COOKIE_STORE_MAX_FILE_BYTES,
      pages: SAFARI_COOKIE_STORE_MAX_PAGES,
      cookies: SAFARI_COOKIE_STORE_MAX_COOKIES,
      parsedBytes: SAFARI_COOKIE_STORE_MAX_PARSED_BYTES
    }).toEqual({
      fileBytes: 64 * 1024 * 1024,
      pages: 65_536,
      cookies: 250_000,
      parsedBytes: 64 * 1024 * 1024
    })
  })
})
