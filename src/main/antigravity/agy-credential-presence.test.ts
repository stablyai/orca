import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

type Keyring = 'item' | 'none' | 'locked' | 'gdbusMissing' | 'secretToolMissing'
const host = vi.hoisted(
  (): { platform: NodeJS.Platform; fileStore: boolean; keyring: Keyring } => ({
    platform: 'linux',
    fileStore: false,
    keyring: 'none'
  })
)
vi.mock('./native-file-credentials', () => ({
  antigravityUsesFileStoreAsync: async () => host.fileStore
}))
const storeItem = vi.hoisted(() => async () => {
  if (host.keyring === 'locked') {
    throw new Error('The credential store could not be read.')
  }
  return host.keyring === 'item'
})
vi.mock('./native-macos-credentials', () => ({ hasAntigravityMacOSCredential: storeItem }))
vi.mock('./native-windows-credentials', () => ({ hasAntigravityWindowsCredential: storeItem }))
vi.mock('./native-linux-credentials', async () => {
  class AntigravityKeyringToolMissingError extends Error {
    constructor(readonly program: 'gdbus' | 'secret-tool') {
      super(`needs ${program}`)
    }
  }
  return {
    AntigravityKeyringToolMissingError,
    readAntigravityLinuxCredential: async () => {
      if (host.keyring === 'locked') {
        throw new Error('Your Linux keyring is locked')
      }
      if (host.keyring === 'gdbusMissing') {
        throw new AntigravityKeyringToolMissingError('gdbus')
      }
      if (host.keyring === 'secretToolMissing') {
        throw new AntigravityKeyringToolMissingError('secret-tool')
      }
      return host.keyring === 'item' ? { contents: '{}' } : null
    }
  }
})

const { agyCredentialPresence } = await import('./agy-credential-presence')

const homes: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true }))
})

function home(files: { token?: boolean; marker?: boolean }): string {
  const path = mkdtempSync(join(tmpdir(), 'agy-presence-'))
  homes.push(path)
  const cli = join(path, '.gemini', 'antigravity-cli')
  if (files.token) {
    mkdirSync(cli, { recursive: true })
    writeFileSync(join(cli, 'antigravity-oauth-token'), '{}')
  }
  if (files.marker) {
    const marker = join(cli, 'cache', 'antigravity-keyring-unavailable')
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, '1')
  }
  return path
}

it.each<
  [string, NodeJS.Platform, Partial<typeof host>, { token?: boolean; marker?: boolean }, string]
>([
  ['a keyring-fallback marker', 'linux', { keyring: 'locked' }, { marker: true }, 'present'],
  [
    'a file-store host with a token',
    'linux',
    { fileStore: true, keyring: 'locked' },
    { token: true },
    'present'
  ],
  ['a file-store host without one', 'linux', { fileStore: true, keyring: 'item' }, {}, 'absent'],
  ['a macOS keychain item', 'darwin', { keyring: 'item' }, {}, 'present'],
  ['a macOS token file', 'darwin', { keyring: 'none' }, { token: true }, 'present'],
  ['macOS with neither', 'darwin', { keyring: 'none' }, {}, 'absent'],
  // A failed read can't say the login is absent.
  ['a macOS keychain that could not be read', 'darwin', { keyring: 'locked' }, {}, 'locked'],
  ['a locked Linux keyring', 'linux', { keyring: 'locked' }, { token: true }, 'locked'],
  ['an unlocked Linux keyring without an item', 'linux', { keyring: 'none' }, {}, 'absent'],
  // agy reaches the Secret Service itself; without gdbus Orca can't tell if it is locked.
  ['a Linux host without gdbus', 'linux', { keyring: 'gdbusMissing' }, { token: true }, 'locked'],
  // secret-tool is needed only once gdbus found the collection unlocked.
  [
    'an unlocked keyring without secret-tool',
    'linux',
    { keyring: 'secretToolMissing' },
    {},
    'present'
  ],
  ['a Windows Credential Manager item', 'win32', { keyring: 'item' }, {}, 'present'],
  ['Windows with neither', 'win32', { keyring: 'none' }, {}, 'absent'],
  ['a Credential Manager that could not be read', 'win32', { keyring: 'locked' }, {}, 'locked']
])('reads %s as its login presence', async (_case, platform, state, files, expected) => {
  Object.assign(host, { fileStore: false, keyring: 'none' }, state)
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)

  expect(await agyCredentialPresence(home(files))).toBe(expected)
})
