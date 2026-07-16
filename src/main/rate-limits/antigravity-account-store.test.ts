import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())
const state = vi.hoisted<{ userData: string }>(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? state.userData : '') },
  net: { fetch: netFetchMock },
  safeStorage: {
    isEncryptionAvailable: () => true,
    // Reversible stand-in for the OS-backed cipher.
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8').replace(/^enc:/, '')
  }
}))

import {
  fetchAccountEmail,
  getAccountCredentials,
  getActiveAccountCredentials,
  getActiveAccountId,
  listAccounts,
  removeAccount,
  setActiveAccount,
  upsertAccount
} from './antigravity-account-store'

const creds = (accessToken: string) => ({
  access_token: accessToken,
  refresh_token: `refresh-${accessToken}`,
  expiry_date: Date.now() + 3_600_000
})

describe('antigravity-account-store', () => {
  beforeEach(() => {
    state.userData = mkdtempSync(join(tmpdir(), 'orca-agy-store-'))
    netFetchMock.mockReset()
  })

  afterEach(() => {
    rmSync(state.userData, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('adds the first account, makes it active, and round-trips encrypted credentials', () => {
    const id = upsertAccount('a@gmail.com', creds('tok-a'))
    expect(getActiveAccountId()).toBe(id)
    expect(listAccounts()).toEqual([{ id, email: 'a@gmail.com', isActive: true }])
    expect(getActiveAccountCredentials()?.access_token).toBe('tok-a')
    expect(getAccountCredentials(id)?.refresh_token).toBe('refresh-tok-a')
  })

  it('keeps the first account active when a second is added without makeActive', () => {
    const first = upsertAccount('a@gmail.com', creds('tok-a'))
    upsertAccount('b@gmail.com', creds('tok-b'))
    expect(getActiveAccountId()).toBe(first)
    expect(listAccounts().map((a) => a.email)).toEqual(['a@gmail.com', 'b@gmail.com'])
  })

  it('switches the active account and updates credentials returned', () => {
    upsertAccount('a@gmail.com', creds('tok-a'))
    const second = upsertAccount('b@gmail.com', creds('tok-b'))
    expect(setActiveAccount(second)).toBe(true)
    expect(getActiveAccountId()).toBe(second)
    expect(getActiveAccountCredentials()?.access_token).toBe('tok-b')
    expect(listAccounts().find((a) => a.id === second)?.isActive).toBe(true)
  })

  it('dedupes by email and refreshes the stored credential', () => {
    const id = upsertAccount('a@gmail.com', creds('tok-a'))
    const again = upsertAccount('a@gmail.com', creds('tok-a2'))
    expect(again).toBe(id)
    expect(listAccounts()).toHaveLength(1)
    expect(getAccountCredentials(id)?.access_token).toBe('tok-a2')
  })

  it('removes an account and re-points the active pointer', () => {
    const first = upsertAccount('a@gmail.com', creds('tok-a'))
    const second = upsertAccount('b@gmail.com', creds('tok-b'))
    setActiveAccount(second)
    removeAccount(second)
    expect(getActiveAccountId()).toBe(first)
    expect(listAccounts()).toHaveLength(1)
  })

  it('setActiveAccount returns false for an unknown id', () => {
    upsertAccount('a@gmail.com', creds('tok-a'))
    expect(setActiveAccount('nope')).toBe(false)
  })

  it('fetchAccountEmail returns the email from the userinfo endpoint', async () => {
    netFetchMock.mockResolvedValue({ ok: true, json: async () => ({ email: 'x@gmail.com' }) })
    expect(await fetchAccountEmail('tok')).toBe('x@gmail.com')
  })

  it('fetchAccountEmail returns null on a failed request', async () => {
    netFetchMock.mockResolvedValue({ ok: false, json: async () => ({}) })
    expect(await fetchAccountEmail('tok')).toBeNull()
  })
})
