import { describe, expect, it, vi } from 'vitest'
import type { CookieClearIdentity } from './storage/cookie-store-contracts'
import type { SourcePartitionRead } from './sources/browser-cookie-source-partition'
import { writeImportedCookies, type SourceCookieToWrite } from './browser-cookie-import-write'

function sourceCookie(
  overrides: Partial<SourceCookieToWrite> & { name: string; partition: SourcePartitionRead }
): SourceCookieToWrite {
  return {
    url: 'https://app.example/',
    value: 'v',
    domain: '.app.example',
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'no_restriction',
    expirationDate: undefined,
    ...overrides
  }
}

function recordingStore() {
  const writeCookieIdentity = vi.fn<(identity: CookieClearIdentity) => Promise<void>>(
    async () => undefined
  )
  return { writeCookieIdentity }
}

const silentOptions = { log: () => undefined }

describe('writeImportedCookies', () => {
  it('never dispatches an expired cookie, which would delete the existing coordinate', async () => {
    const store = recordingStore()
    const result = await writeImportedCookies(
      store,
      [
        sourceCookie({
          name: 'sid',
          expirationDate: 1,
          partition: { status: 'unpartitioned' }
        })
      ],
      silentOptions
    )
    expect(result).toMatchObject({ importedCount: 0, expired: 1, writeRejected: 0 })
    expect(store.writeCookieIdentity).not.toHaveBeenCalled()
  })
})
