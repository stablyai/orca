import { describe, expect, it, vi } from 'vitest'
import type { CookieClearIdentity } from './browser-cookie-import-clear'
import type { ValidatedCookie } from './sources/browser-cookie-validation'

vi.mock('electron', () => ({ dialog: {}, session: {} }))
vi.mock('./browser-cookie-import-diagnostics', () => ({
  diag: vi.fn(),
  reasonWithDiagLog: (message: string) => message,
  summarizeCookieImportError: String
}))

import { importValidatedCookies } from './browser-cookie-import-pipeline'

function cookie(name: string, overrides: Partial<ValidatedCookie> = {}): ValidatedCookie {
  return {
    url: 'https://app.example/',
    domain: 'app.example',
    name,
    value: 'imported',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    expirationDate: undefined,
    partition: { status: 'unpartitioned' },
    ...overrides
  }
}

function target() {
  const jar = new Map([
    ['sid', 'working'],
    ['site-set', 'rotated']
  ])
  const store = {
    get: vi.fn(),
    remove: vi.fn(),
    snapshotClearIdentities: vi.fn(),
    restoreClearIdentities: vi.fn(),
    dispose: vi.fn(),
    writeCookieIdentity: vi.fn(async (identity: CookieClearIdentity) => {
      if (identity.sameSite === 'no_restriction' && !identity.secure) {
        throw new Error('SameSite=None requires Secure')
      }
      jar.set(identity.name, identity.value)
    })
  }
  return {
    jar,
    store,
    partition: 'persist:merge-test',
    mutationLockOwner: {},
    openWriteStore: () => store
  }
}

describe('merge-only cookie import', () => {
  it('keeps an existing session on rejection and imports valid/rejected/valid rows without rollback', async () => {
    const destination = target()
    const result = await importValidatedCookies(
      [
        cookie('first'),
        cookie('sid', { sameSite: 'no_restriction', secure: false }),
        cookie('last')
      ],
      3,
      destination
    )
    expect(result).toMatchObject({ ok: true, summary: { importedCookies: 2, skippedCookies: 1 } })
    expect([...destination.jar]).toEqual([
      ['sid', 'working'],
      ['site-set', 'rotated'],
      ['first', 'imported'],
      ['last', 'imported']
    ])
    expect(destination.store.get).not.toHaveBeenCalled()
    expect(destination.store.remove).not.toHaveBeenCalled()
    expect(destination.store.snapshotClearIdentities).not.toHaveBeenCalled()
    expect(destination.store.restoreClearIdentities).not.toHaveBeenCalled()
  })

  it('refuses an incapable client before writes but imports readable siblings for a capable client', async () => {
    const destination = target()
    const rows = [
      cookie('readable'),
      cookie('unreadable', { partition: { status: 'unreadable', reason: 'missing ancestor' } })
    ]
    expect(
      await importValidatedCookies(rows, 2, destination, {
        canReportPartitionSkippedCookies: false
      })
    ).toMatchObject({ ok: false })
    expect(destination.store.writeCookieIdentity).not.toHaveBeenCalled()
    expect(
      await importValidatedCookies(rows, 2, destination, { canReportPartitionSkippedCookies: true })
    ).toMatchObject({
      ok: true,
      summary: {
        importedCookies: 1,
        skippedCookies: 1,
        partitionSkipBreakdown: { unreadableCookies: 1, preservedRelatedCookies: 0 }
      }
    })
    expect(destination.store.writeCookieIdentity).toHaveBeenCalledOnce()
  })
})
