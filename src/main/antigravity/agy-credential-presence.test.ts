import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agyCredentialPresence } from './agy-credential-presence'

// The file store is the one agy uses here, so only the token file and the fallback marker count.
vi.mock('./native-file-credentials', () => ({ antigravityUsesFileStoreAsync: async () => true }))

let home = ''
const agyDir = () => join(home, '.gemini', 'antigravity-cli')

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agy-presence-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

it('reads the login as absent when its files do not exist (ENOENT)', async () => {
  expect(await agyCredentialPresence(home)).toBe('absent')
})

it('reads the login as absent when a parent is not a folder (ENOTDIR)', async () => {
  writeFileSync(join(home, '.gemini'), '')
  expect(await agyCredentialPresence(home)).toBe('absent')
})

// A token file Orca can't stat for another reason (permissions, a failing disk, here a symlink
// loop) may well hold the login.
// Creating a symlink needs extra rights on Windows.
it.skipIf(process.platform === 'win32')("reads a token file it can't stat as can't check, never absent", async () => {
  mkdirSync(agyDir(), { recursive: true })
  const token = join(agyDir(), 'antigravity-oauth-token')
  symlinkSync(token, token)
  expect(await agyCredentialPresence(home)).toBe('locked')
})
