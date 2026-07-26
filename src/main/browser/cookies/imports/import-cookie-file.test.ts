import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const importValidatedCookies = vi.hoisted(() => vi.fn())

vi.mock('./import-validated-cookies', () => ({
  importValidatedCookies
}))

vi.mock('../storage/browser-cookie-session-target', () => ({
  cookieImportTarget: (partition: string) => ({ partition })
}))

import { importCookiesFromFile, parseCookieImportPayload } from './import-cookie-file'

describe('parseCookieImportPayload', () => {
  it('accepts EditThisCookie arrays', () => {
    const result = parseCookieImportPayload([{ domain: '.a.com', name: 'n', value: 'v' }])
    expect(result).toEqual({
      ok: true,
      total: 1,
      entries: [{ domain: '.a.com', name: 'n', value: 'v' }]
    })
  })

  it('accepts Playwright storage_state objects', () => {
    const result = parseCookieImportPayload({
      cookies: [{ domain: '.a.com', name: 'n', value: 'v', expires: -1 }],
      origins: []
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.total).toBe(1)
    expect(result.entries).toHaveLength(1)
  })

  it('rejects empty and unknown shapes with clear reasons', () => {
    expect(parseCookieImportPayload([])).toEqual({ ok: false, reason: 'Cookie file is empty.' })
    expect(parseCookieImportPayload({ cookies: [] })).toEqual({
      ok: false,
      reason: 'Cookie file is empty.'
    })
    const unknown = parseCookieImportPayload({ foo: 1 })
    expect(unknown.ok).toBe(false)
    if (unknown.ok) {
      return
    }
    expect(unknown.reason).toContain('EditThisCookie')
    expect(unknown.reason).toContain('storage_state')
  })
})

describe('importCookiesFromFile', () => {
  let tmpDir: string

  afterEach(() => {
    importValidatedCookies.mockReset()
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('rejects non-array JSON without a cookies field', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-import-'))
    const filePath = join(tmpDir, 'object.json')
    writeFileSync(filePath, '{"domain": "test.com"}')

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toContain('EditThisCookie')
    expect(result.reason).toContain('storage_state')
    expect(importValidatedCookies).not.toHaveBeenCalled()
  })

  it('imports Playwright storage_state cookies and maps expires onto expirationDate', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-import-'))
    const filePath = join(tmpDir, 'storage_state.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        cookies: [
          {
            name: 'session',
            value: 'pw-token',
            domain: '.example.com',
            path: '/',
            expires: 1800000000,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax'
          },
          {
            name: 'session_only',
            value: 'temp',
            domain: 'app.example.com',
            path: '/',
            expires: -1,
            httpOnly: false,
            secure: true,
            sameSite: 'None'
          }
        ],
        origins: []
      })
    )
    importValidatedCookies.mockResolvedValue({ ok: true, profileId: '', summary: {} })

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result.ok).toBe(true)
    expect(importValidatedCookies).toHaveBeenCalledTimes(1)
    const [cookies, total, target] = importValidatedCookies.mock.calls[0]
    expect(total).toBe(2)
    expect(target).toEqual({ partition: 'persist:test' })
    expect(cookies).toEqual([
      expect.objectContaining({
        name: 'session',
        value: 'pw-token',
        domain: '.example.com',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        expirationDate: 1800000000
      }),
      expect.objectContaining({
        name: 'session_only',
        expirationDate: undefined,
        sameSite: 'no_restriction'
      })
    ])
  })
})
