import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import { CursorAccountService } from './service'
import { resolveCursorStateDbPath } from './cursor-auth-discovery'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/types'

let appDataDir: string

function createStore(overrides: Partial<GlobalSettings> = {}) {
  let settings: GlobalSettings = { ...getDefaultSettings('/home/test'), ...overrides }
  return {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
  }
}

function seedSignedInCursor(email: string): void {
  mkdirSync(join(appDataDir, 'Cursor', 'User', 'globalStorage'), { recursive: true })
  const db = new SyncDatabase(resolveCursorStateDbPath(appDataDir))
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
  const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
  insert.run('cursorAuth/cachedEmail', email)
  insert.run('cursorAuth/stripeMembershipType', 'pro')
  insert.run('glass.lastSignedInAuthId', `auth-${email}`)
  db.close()
}

beforeEach(() => {
  appDataDir = mkdtempSync(join(tmpdir(), 'cursor-service-'))
})

afterEach(() => {
  rmSync(appDataDir, { recursive: true, force: true })
})

describe('CursorAccountService', () => {
  it('mirrors the signed-in Cursor identity into the roster and auto-selects it', () => {
    seedSignedInCursor('dev@example.com')
    const store = createStore()
    const service = new CursorAccountService(store as never, () => appDataDir)
    const state = service.listAccounts()
    expect(state.accounts).toHaveLength(1)
    expect(state.accounts[0]?.email).toBe('dev@example.com')
    expect(state.accounts[0]?.membershipType).toBe('pro')
    expect(state.activeAccountId).toBe(state.accounts[0]?.id)
  })

  it('reuses the createdAt on rescan and does not duplicate the account', () => {
    seedSignedInCursor('dev@example.com')
    const store = createStore()
    const service = new CursorAccountService(store as never, () => appDataDir)
    const first = service.listAccounts()
    const second = service.listAccounts()
    expect(second.accounts).toHaveLength(1)
    expect(second.accounts[0]?.id).toBe(first.accounts[0]?.id)
  })

  it('lists an empty roster when Cursor is signed out', () => {
    const store = createStore()
    const service = new CursorAccountService(store as never, () => appDataDir)
    expect(service.listAccounts().accounts).toHaveLength(0)
  })

  it('removes a discovered account', async () => {
    seedSignedInCursor('dev@example.com')
    const store = createStore()
    const service = new CursorAccountService(store as never, () => appDataDir)
    const id = service.listAccounts().accounts[0]!.id
    const state = await service.removeAccount(id)
    expect(state.accounts).toHaveLength(0)
    expect(state.activeAccountId).toBeNull()
  })

  it('rejects selecting an unknown account', async () => {
    const store = createStore()
    const service = new CursorAccountService(store as never, () => appDataDir)
    await expect(service.selectAccount('missing')).rejects.toThrow('no longer exists')
  })
})
