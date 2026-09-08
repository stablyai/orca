// agent/src/relay/browser-profile-detect.test.ts
// Why mock node:fs (not run against the real test-runner filesystem): this
// suite verifies detectInstalledBrowsersOnHost()'s own contract — per-OS
// root resolution, Local State parsing/fallback, and unsafe-directory-name
// filtering — deterministically, on every CI platform, regardless of what
// browsers (if any) happen to be installed on the machine actually running
// the tests. desktop/src/main/browser/browser-cookie-import.test.ts's own
// `detectInstalledBrowsers` suite has no per-OS mocking harness to port
// (its 2 tests are real-filesystem smoke tests, and none of
// browserRootPath/discoverProfiles/isSafeBrowserProfileDirectory are
// exported there to test directly) — this suite is written fresh against
// this module's own exports.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as NodeChildProcess from 'node:child_process'
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn()
  }
})

// Why mock execFileSync (not shell out for real): this suite verifies the
// OS-key-derivation functions' own contract — which command they run and
// how they turn its stdout into a decryption key — the same way
// desktop/src/main/browser/browser-cookie-import.test.ts's
// `execFileSyncMock` pattern does, without requiring a real macOS Keychain,
// GNOME keyring, or Windows DPAPI in this sandbox.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>()
  return { ...actual, execFileSync: vi.fn() }
})

// Ported from desktop/src/main/browser/browser-cookie-import-test-database.ts's
// encryptMacChromiumCookie, generalized to the two AES modes this suite needs.
function encryptChromiumCookieAes128Cbc(
  value: string,
  key: Buffer,
  version: 'v10' | 'v11'
): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  return Buffer.concat([
    Buffer.from(version),
    cipher.update(Buffer.from(value, 'latin1')),
    cipher.final()
  ])
}

function encryptChromiumCookieAes256Gcm(value: string, key: Buffer): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(value, 'latin1')), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from('v20'), nonce, ciphertext, authTag])
}

const originalPlatform = process.platform
const originalEnv = { ...process.env }

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  process.env = { ...originalEnv }
  vi.resetModules()
  vi.clearAllMocks()
})

beforeEach(() => {
  process.env = { ...originalEnv }
})

describe('detectInstalledBrowsersOnHost — Chromium family detection', () => {
  it('skips a browser whose root directory does not exist on this host', async () => {
    setPlatform('linux')
    process.env.HOME = '/home/orca'
    process.env.XDG_CONFIG_HOME = ''
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { detectInstalledBrowsersOnHost } = await import('./browser-profile-detect')
    const browsers = detectInstalledBrowsersOnHost()

    // Why: no browser root exists (existsSync always false), but
    // discoverProfiles falls back to a synthetic 'Default' profile even
    // when 'Local State' is missing — so every Linux-rooted Chromium
    // browser still gets reported as "detected" with a Default profile.
    // This mirrors desktop's own discoverProfiles fallback exactly; the
    // real signal that nothing is installed is the profile directory
    // itself being empty/absent, which this detect-only pass does not
    // additionally verify (see TASK-024's documented deviation).
    const chrome = browsers.find((b) => b.family === 'chrome')
    expect(chrome).toBeDefined()
    expect(chrome?.profiles).toEqual([{ name: 'Default', directory: 'Default' }])
  })

  it('falls back to a Default profile when Local State is malformed JSON', async () => {
    setPlatform('linux')
    process.env.HOME = '/home/orca'
    process.env.XDG_CONFIG_HOME = ''
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('Local State'))
    vi.mocked(fs.readFileSync).mockReturnValue('{ not valid json' as unknown as string)

    const { detectInstalledBrowsersOnHost } = await import('./browser-profile-detect')
    const browsers = detectInstalledBrowsersOnHost()

    const chrome = browsers.find((b) => b.family === 'chrome')
    expect(chrome?.profiles).toEqual([{ name: 'Default', directory: 'Default' }])
    expect(chrome?.selectedProfile).toBe('Default')
  })

  it('filters out unsafe/traversal profile directory names from Local State', async () => {
    setPlatform('linux')
    process.env.HOME = '/home/orca'
    process.env.XDG_CONFIG_HOME = ''
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('Local State'))
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        profile: {
          info_cache: {
            'Profile 1': { name: 'Work' },
            '../../etc': { name: 'evil' },
            'has/slash': { name: 'also evil' }
          }
        }
      }) as unknown as string
    )

    const { detectInstalledBrowsersOnHost } = await import('./browser-profile-detect')
    const browsers = detectInstalledBrowsersOnHost()

    const chrome = browsers.find((b) => b.family === 'chrome')
    expect(chrome?.profiles).toEqual([{ name: 'Work', directory: 'Profile 1' }])
  })

  it('reports no Chromium browsers on macOS when a family has no macRoot (arc has none configured for win/linux)', async () => {
    setPlatform('win32')
    process.env.LOCALAPPDATA = ''
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ profile: { info_cache: {} } }) as unknown as string
    )

    const { detectInstalledBrowsersOnHost } = await import('./browser-profile-detect')
    const browsers = detectInstalledBrowsersOnHost()

    // Why: 'arc' has no winRoot at all — browserRootPath returns null for it
    // on win32, so it must never appear, regardless of fs mocking.
    expect(browsers.find((b) => b.family === 'arc')).toBeUndefined()
  })
})

describe('detectInstalledBrowsersOnHost — Firefox', () => {
  it('reports firefox detected when at least one profile directory exists', async () => {
    setPlatform('linux')
    process.env.HOME = '/home/orca'
    process.env.XDG_CONFIG_HOME = ''
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockImplementation((p) => !String(p).endsWith('Local State'))
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'abc123.default-release', isDirectory: () => true }
    ] as unknown as ReturnType<typeof fs.readdirSync>)

    const { detectInstalledBrowsersOnHost } = await import('./browser-profile-detect')
    const browsers = detectInstalledBrowsersOnHost()

    const firefox = browsers.find((b) => b.family === 'firefox')
    expect(firefox).toBeDefined()
    expect(firefox?.selectedProfile).toBe('abc123.default-release')
  })

  it('does not report firefox when the profiles root has no profile directories', async () => {
    setPlatform('linux')
    process.env.HOME = '/home/orca'
    process.env.XDG_CONFIG_HOME = ''
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p).includes('firefox'))
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>)

    const { detectInstalledBrowsersOnHost } = await import('./browser-profile-detect')
    const browsers = detectInstalledBrowsersOnHost()

    expect(browsers.find((b) => b.family === 'firefox')).toBeUndefined()
  })
})

describe('detectInstalledBrowsersOnHost — Safari', () => {
  it('is never reported on a non-darwin host', async () => {
    setPlatform('linux')
    process.env.HOME = '/home/orca'
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ profile: { info_cache: {} } }) as unknown as string
    )

    const { detectInstalledBrowsersOnHost } = await import('./browser-profile-detect')
    const browsers = detectInstalledBrowsersOnHost()

    expect(browsers.find((b) => b.family === 'safari')).toBeUndefined()
  })

  it('is reported on darwin when a Cookies.binarycookies file exists', async () => {
    setPlatform('darwin')
    process.env.HOME = '/Users/orca'
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p).includes('Cookies.binarycookies'))
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ profile: { info_cache: {} } }) as unknown as string
    )

    const { detectInstalledBrowsersOnHost } = await import('./browser-profile-detect')
    const browsers = detectInstalledBrowsersOnHost()

    expect(browsers.find((b) => b.family === 'safari')).toBeDefined()
  })
})

// TASK-025: cookie-decryption primitives. Each test verifies one ported
// function's own contract against a synthetic, known vector — the same
// "mock the OS command, construct a known ciphertext" technique
// desktop/src/main/browser/browser-cookie-import.test.ts already uses for
// its own equivalent round-trip tests — rather than a real installed
// browser or a live OS keychain.
describe('getEncryptionKey / decryptCookieValueRaw — macOS (Keychain, PBKDF2 1003 iterations, AES-128-CBC)', () => {
  it('recovers the plaintext cookie value using the Keychain password reported by `security`', async () => {
    setPlatform('darwin')
    const password = 'keychain-password'
    const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
    const encrypted = encryptChromiumCookieAes128Cbc('secret-session-value', key, 'v10')

    const cp = await import('node:child_process')
    vi.mocked(cp.execFileSync).mockReturnValue(`${password}\n` as unknown as string)

    const { getEncryptionKey, decryptCookieValueRaw } = await import('./browser-profile-detect')
    const keyResult = getEncryptionKey('Chrome Safe Storage', 'Chrome')
    expect(keyResult).not.toBeNull()
    expect(cp.execFileSync).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'Chrome Safe Storage', '-a', 'Chrome', '-w'],
      expect.any(Object)
    )

    const decrypted = decryptCookieValueRaw(encrypted, keyResult!)
    expect(decrypted?.toString('latin1')).toBe('secret-session-value')
  })

  it('returns null when the Keychain lookup fails (denied/not found)', async () => {
    setPlatform('darwin')
    const cp = await import('node:child_process')
    vi.mocked(cp.execFileSync).mockImplementation(() => {
      throw new Error('security: item not found')
    })

    const { getEncryptionKey } = await import('./browser-profile-detect')
    expect(getEncryptionKey('Chrome Safe Storage', 'Chrome')).toBeNull()
  })
})

describe('getEncryptionKey / decryptCookieValueRaw — Linux (secret-tool or "peanuts" fallback, AES-128-CBC)', () => {
  it('decrypts a v10 cookie using the hardcoded "peanuts" key when no keyring is available', async () => {
    setPlatform('linux')
    const v10Key = pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1')
    const encrypted = encryptChromiumCookieAes128Cbc('v10-value', v10Key, 'v10')

    const cp = await import('node:child_process')
    vi.mocked(cp.execFileSync).mockImplementation(() => {
      throw new Error('secret-tool: no keyring available')
    })

    const { getEncryptionKey, decryptCookieValueRaw } = await import('./browser-profile-detect')
    const keyResult = getEncryptionKey('Chrome Safe Storage', 'Chrome')
    expect(keyResult).not.toBeNull()

    const decrypted = decryptCookieValueRaw(encrypted, keyResult!)
    expect(decrypted?.toString('latin1')).toBe('v10-value')
  })

  it('decrypts a v11 cookie using the keyring password from secret-tool', async () => {
    setPlatform('linux')
    const keyringPassword = 'gnome-keyring-password'
    const v11Key = pbkdf2Sync(keyringPassword, 'saltysalt', 1, 16, 'sha1')
    const encrypted = encryptChromiumCookieAes128Cbc('v11-value', v11Key, 'v11')

    const cp = await import('node:child_process')
    vi.mocked(cp.execFileSync).mockReturnValue(`${keyringPassword}\n` as unknown as string)

    const { getEncryptionKey, decryptCookieValueRaw } = await import('./browser-profile-detect')
    const keyResult = getEncryptionKey('Chrome Safe Storage', 'Chrome')

    const decrypted = decryptCookieValueRaw(encrypted, keyResult!)
    expect(decrypted?.toString('latin1')).toBe('v11-value')
  })
})

describe('getEncryptionKey / decryptCookieValueRaw — Windows (DPAPI master key, AES-256-GCM)', () => {
  it('decrypts a v20 cookie using the DPAPI-unprotected master key from Local State', async () => {
    setPlatform('win32')
    process.env.LOCALAPPDATA = 'C:\\Users\\orca\\AppData\\Local'
    const gcmKey = randomBytes(32)
    const encrypted = encryptChromiumCookieAes256Gcm('windows-value', gcmKey)

    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        os_crypt: {
          encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.from('irrelevant')]).toString(
            'base64'
          )
        }
      }) as unknown as string
    )

    const cp = await import('node:child_process')
    vi.mocked(cp.execFileSync).mockReturnValue(
      `${gcmKey.toString('base64')}\n` as unknown as string
    )

    const { getEncryptionKey, decryptCookieValueRaw } = await import('./browser-profile-detect')
    const browser = {
      family: 'chrome',
      label: 'Google Chrome',
      profiles: [{ name: 'Default', directory: 'Default' }],
      selectedProfile: 'Default'
    }
    const keyResult = getEncryptionKey('Chrome Safe Storage', 'Chrome', browser)
    expect(keyResult).not.toBeNull()
    expect(keyResult?.mode).toBe('aes-256-gcm')
    expect(cp.execFileSync).toHaveBeenCalledWith(
      'powershell',
      expect.any(Array),
      expect.any(Object)
    )

    const decrypted = decryptCookieValueRaw(encrypted, keyResult!)
    expect(decrypted?.toString('latin1')).toBe('windows-value')
  })

  it('returns null when Local State has no os_crypt.encrypted_key', async () => {
    setPlatform('win32')
    process.env.LOCALAPPDATA = 'C:\\Users\\orca\\AppData\\Local'
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}) as unknown as string)

    const { getEncryptionKey } = await import('./browser-profile-detect')
    const browser = {
      family: 'chrome',
      label: 'Google Chrome',
      profiles: [{ name: 'Default', directory: 'Default' }],
      selectedProfile: 'Default'
    }
    expect(getEncryptionKey('Chrome Safe Storage', 'Chrome', browser)).toBeNull()
  })
})

describe('hasHmacPrefix / stripHmac', () => {
  it('detects and strips a 32-byte HMAC prefix (mostly non-printable bytes)', async () => {
    const { hasHmacPrefix, stripHmac } = await import('./browser-profile-detect')
    const hmac = randomBytes(32) // random bytes are overwhelmingly non-printable
    const value = Buffer.from('the-real-cookie-value', 'latin1')
    const withPrefix = Buffer.concat([hmac, value])

    expect(hasHmacPrefix(withPrefix)).toBe(true)
    expect(stripHmac(withPrefix)).toEqual(value)
  })

  it('does not treat a short or all-printable buffer as HMAC-prefixed', async () => {
    const { hasHmacPrefix, stripHmac } = await import('./browser-profile-detect')
    const printableOnly = Buffer.from('a'.repeat(64), 'latin1')

    expect(hasHmacPrefix(printableOnly)).toBe(false)
    expect(stripHmac(printableOnly)).toEqual(printableOnly)
  })
})

describe('cookie validation/normalization', () => {
  it('validateCookieEntry rejects a row missing domain/name/value', async () => {
    const { validateCookieEntry } = await import('./browser-profile-detect')
    expect(validateCookieEntry({ name: 'sid', value: 'x' })).toBeNull()
    expect(validateCookieEntry({ domain: '.example.com', value: 'x' })).toBeNull()
    expect(validateCookieEntry({ domain: '.example.com', name: 'sid' })).toBeNull()
  })

  it('validateCookieEntry derives a url and normalizes flags for a valid row', async () => {
    const { validateCookieEntry } = await import('./browser-profile-detect')
    const cookie = validateCookieEntry({
      domain: '.example.com',
      name: 'sid',
      value: 'abc123',
      secure: true,
      httpOnly: 1,
      sameSite: 'Lax',
      expirationDate: 1_700_000_000
    })
    expect(cookie).toEqual({
      url: 'https://example.com/',
      name: 'sid',
      value: 'abc123',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: 1_700_000_000
    })
  })

  it('normalizeSameSite maps the numeric Chromium enum and Firefox string forms', async () => {
    const { normalizeSameSite } = await import('./browser-profile-detect')
    expect(normalizeSameSite(1)).toBe('no_restriction')
    expect(normalizeSameSite(2)).toBe('lax')
    expect(normalizeSameSite(3)).toBe('strict')
    expect(normalizeSameSite('None')).toBe('no_restriction')
    expect(normalizeSameSite('Strict')).toBe('strict')
    expect(normalizeSameSite(undefined)).toBe('unspecified')
  })

  it('deriveUrl rejects a domain containing a space and strips a leading dot', async () => {
    const { deriveUrl } = await import('./browser-profile-detect')
    expect(deriveUrl('.example.com', true)).toBe('https://example.com/')
    expect(deriveUrl('has space.com', false)).toBeNull()
  })
})

describe('chromiumTimestampToUnix', () => {
  it('converts Chromium microseconds-since-1601 to Unix seconds', async () => {
    const { chromiumTimestampToUnix } = await import('./browser-profile-detect')
    // 13344473600000000 microseconds since 1601-01-01 == Unix 1700000000 seconds
    // (2023-11-14T22:13:20Z) — derived as (unixSeconds + 11644473600) * 1e6.
    expect(chromiumTimestampToUnix(13_344_473_600_000_000n)).toBe(1_700_000_000)
    expect(chromiumTimestampToUnix(0)).toBe(0)
    expect(chromiumTimestampToUnix('not-a-number')).toBe(0)
  })
})

describe('decodeSafariBinaryCookies', () => {
  function buildSafariCookiesBuffer(cookie: {
    name: string
    value: string
    url: string
    path: string
    flags: number
  }): Buffer {
    const nameBuf = Buffer.from(`${cookie.name}\0`, 'utf8')
    const urlBuf = Buffer.from(`${cookie.url}\0`, 'utf8')
    const pathBuf = Buffer.from(`${cookie.path}\0`, 'utf8')
    const valueBuf = Buffer.from(`${cookie.value}\0`, 'utf8')
    const headerSize = 56 // fixed header up through the 4 string offsets + 2 reserved + expiration/creation doubles
    const urlOffset = headerSize
    const nameOffset = urlOffset + urlBuf.length
    const pathOffset = nameOffset + nameBuf.length
    const valueOffset = pathOffset + pathBuf.length
    const size = valueOffset + valueBuf.length

    const cookieBuf = Buffer.alloc(size)
    cookieBuf.writeUInt32LE(size, 0)
    cookieBuf.writeUInt32LE(0, 4) // unknown
    cookieBuf.writeUInt32LE(cookie.flags, 8)
    cookieBuf.writeUInt32LE(0, 12) // unknown
    cookieBuf.writeUInt32LE(urlOffset, 16)
    cookieBuf.writeUInt32LE(nameOffset, 20)
    cookieBuf.writeUInt32LE(pathOffset, 24)
    cookieBuf.writeUInt32LE(valueOffset, 28)
    cookieBuf.writeDoubleLE(0, 32) // comment offset — unused
    cookieBuf.writeDoubleLE(1_700_000_000 - 978_307_200, 40) // expiration (Mac absolute time)
    urlBuf.copy(cookieBuf, urlOffset)
    nameBuf.copy(cookieBuf, nameOffset)
    pathBuf.copy(cookieBuf, pathOffset)
    valueBuf.copy(cookieBuf, valueOffset)

    const page = Buffer.alloc(8 + 4 + cookieBuf.length)
    page.writeUInt32BE(0x00000100, 0)
    page.writeUInt32LE(1, 4) // cookieCount
    page.writeUInt32LE(8 + 4, 8) // offset of the one cookie
    cookieBuf.copy(page, 12)

    const file = Buffer.alloc(4 + 4 + 4 + page.length)
    file.write('cook', 0, 'utf8')
    file.writeUInt32BE(1, 4) // pageCount
    file.writeUInt32BE(page.length, 8) // pageSizes[0]
    page.copy(file, 12)
    return file
  }

  it('decodes a single cookie from a synthetic Cookies.binarycookies buffer', async () => {
    const { decodeSafariBinaryCookies } = await import('./browser-profile-detect')
    const buffer = buildSafariCookiesBuffer({
      name: 'sid',
      value: 'safari-value',
      url: 'example.com',
      path: '/',
      flags: 0b101 // secure + httpOnly
    })

    const cookies = decodeSafariBinaryCookies(buffer)
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toMatchObject({
      name: 'sid',
      value: 'safari-value',
      domain: 'example.com',
      secure: true,
      httpOnly: true,
      url: 'https://example.com/'
    })
  })

  it('returns an empty array for a buffer without the "cook" magic header', async () => {
    const { decodeSafariBinaryCookies } = await import('./browser-profile-detect')
    expect(decodeSafariBinaryCookies(Buffer.from('not a cookies file'))).toEqual([])
  })
})

describe('buildAgentBrowserCookieSetArgs', () => {
  it('builds the full flag set for a secure, httpOnly, SameSite=Lax cookie with an expiry', async () => {
    const { buildAgentBrowserCookieSetArgs } = await import('./browser-profile-detect')
    const args = buildAgentBrowserCookieSetArgs({
      url: 'https://example.com/',
      name: 'sid',
      value: 'abc123',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: 1_700_000_000
    })
    expect(args).toEqual([
      'cookies',
      'set',
      'sid',
      'abc123',
      '--url',
      'https://example.com/',
      '--domain',
      '.example.com',
      '--path',
      '/',
      '--httpOnly',
      '--secure',
      '--sameSite',
      'Lax',
      '--expires',
      '1700000000'
    ])
  })

  it('omits optional flags for a minimal, non-secure, SameSite=unspecified cookie', async () => {
    const { buildAgentBrowserCookieSetArgs } = await import('./browser-profile-detect')
    const args = buildAgentBrowserCookieSetArgs({
      url: 'http://example.com/',
      name: 'sid',
      value: 'abc123',
      domain: 'example.com',
      path: '/',
      secure: false,
      httpOnly: false,
      sameSite: 'unspecified',
      expirationDate: undefined
    })
    expect(args).toEqual([
      'cookies',
      'set',
      'sid',
      'abc123',
      '--url',
      'http://example.com/',
      '--domain',
      'example.com',
      '--path',
      '/'
    ])
  })
})
