import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readKeychainPassword } from '../macos-keychain/generic-password'
import { readCursorLinuxKeyringSecret } from '../rate-limits/providers/cursor/cursor-linux-keyring'
import { getCursorAccountStatus } from './status'

let dir = ''

vi.mock('../macos-keychain/generic-password', () => ({ readKeychainPassword: vi.fn() }))
vi.mock('../rate-limits/providers/cursor/cursor-linux-keyring', () => ({
  readCursorLinuxKeyringSecret: vi.fn()
}))
vi.mock('../foreign-sqlite-readers/foreign-sqlite-reader-spawn', () => ({
  readCursorDesktopProfile: vi.fn(async () => ({ status: 'missing' }))
}))
// No IDE database: only the CLI's own store could hold this login.
vi.mock('../rate-limits/providers/cursor/cursor-auth-paths', () => ({
  getCursorCliAuthPath: () => join(dir, 'auth.json'),
  getCursorCliConfigPath: () => join(dir, 'cli-config.json'),
  getCursorDesktopStateDbPath: () => join(dir, 'state.vscdb')
}))

const platform = (name: NodeJS.Platform) =>
  vi.spyOn(process, 'platform', 'get').mockReturnValue(name)
// cursor-agent leaves only this marker in auth.json when the OS secret store holds the token.
const markSecretStore = () =>
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ storedIn: 'os-secret-store' }))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cursor-status-'))
  vi.mocked(readKeychainPassword).mockReset()
  vi.mocked(readCursorLinuxKeyringSecret).mockReset()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// Incident replay: a keychain read that timed out under load is no answer about the login.
it('reports a timed-out macOS keychain read as "can\'t check right now", not signed out', async () => {
  platform('darwin')
  vi.mocked(readKeychainPassword).mockRejectedValue(
    Object.assign(new Error('security timed out after 3000ms'), { code: 'ETIMEDOUT' })
  )
  const status = await getCursorAccountStatus()
  expect(status.signedIn).toBe(false)
  expect(status.checkUnavailable).toBe(true)
})

it('still reports signed out when the keychain definitively has no Cursor login', async () => {
  platform('darwin')
  vi.mocked(readKeychainPassword).mockResolvedValue(null)
  const status = await getCursorAccountStatus()
  expect(status.signedIn).toBe(false)
  expect(status.checkUnavailable).toBeUndefined()
  expect(status.error).toBeNull()
})

it('reports a Windows secret-store file it could not read (not missing) as "can\'t check"', async () => {
  platform('win32')
  markSecretStore()
  // A path that exists but can't be read as a file: EISDIR, as EBUSY or EACCES would be.
  mkdirSync(join(dir, 'auth.dpapi'))
  const status = await getCursorAccountStatus()
  expect(status.signedIn).toBe(false)
  expect(status.checkUnavailable).toBe(true)
})

it('reports a remembered Linux keyring failure as "can\'t check", never signed out', async () => {
  platform('linux')
  markSecretStore()
  vi.mocked(readCursorLinuxKeyringSecret).mockResolvedValue({
    status: 'error',
    error: "Orca couldn't read the Cursor login from your Linux keyring (locked or access not granted)."
  })
  const first = await getCursorAccountStatus()
  expect(first.checkUnavailable).toBe(true)
  // The failure stays cached (each read may prompt), and stays "can't check".
  const second = await getCursorAccountStatus()
  expect(second.checkUnavailable).toBe(true)
  expect(readCursorLinuxKeyringSecret).toHaveBeenCalledTimes(1)
})
