import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readKeychainPassword } from '../macos-keychain/generic-password'
import { getCursorAccountStatus } from './status'

let dir = ''

vi.mock('../macos-keychain/generic-password', () => ({ readKeychainPassword: vi.fn() }))
vi.mock('../foreign-sqlite-readers/foreign-sqlite-reader-spawn', () => ({
  readCursorDesktopProfile: vi.fn(async () => ({ status: 'missing' }))
}))
// No auth.json or IDE database: the keychain is the only place this login could be.
vi.mock('../rate-limits/providers/cursor/cursor-auth-paths', () => ({
  getCursorCliAuthPath: () => join(dir, 'auth.json'),
  getCursorCliConfigPath: () => join(dir, 'cli-config.json'),
  getCursorDesktopStateDbPath: () => join(dir, 'state.vscdb')
}))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cursor-status-'))
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.mocked(readKeychainPassword).mockReset()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// Incident replay: a keychain read that timed out under load is no answer about the login.
it('reports a timed-out keychain read as "can\'t check right now", not signed out', async () => {
  vi.mocked(readKeychainPassword).mockRejectedValue(
    Object.assign(new Error('security timed out after 3000ms'), { code: 'ETIMEDOUT' })
  )
  const status = await getCursorAccountStatus()
  expect(status.signedIn).toBe(false)
  expect(status.checkUnavailable).toBe(true)
})

it('still reports signed out when the keychain definitively has no Cursor login', async () => {
  vi.mocked(readKeychainPassword).mockResolvedValue(null)
  const status = await getCursorAccountStatus()
  expect(status.signedIn).toBe(false)
  expect(status.checkUnavailable).toBeUndefined()
  expect(status.error).toBeNull()
})
