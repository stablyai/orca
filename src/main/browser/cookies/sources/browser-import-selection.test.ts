import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDarwinUserTempDir } from '../../../window/file-drop/darwin-user-temp-dir'
import { browserCookieImportSource } from '../route-partition/browser-route-partition-cookie-import'

vi.mock('electron', () => ({}))
vi.mock('../browser-cookie-import', () => ({}))
vi.mock('../imports/import-cookie-file', () => ({}))
vi.mock('../session-restore/browser-session-cookie-route-restore', () => ({}))

let home: string
let root: string

beforeEach(async () => {
  // macOS restricts Chrome-shaped paths in the runner's shortened /private/tmp root.
  home = mkdtempSync(join(await getDarwinUserTempDir(), 'orca-chrome-selection-'))
  root =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Google', 'Chrome')
      : process.platform === 'win32'
        ? join(home, 'Google', 'Chrome', 'User Data')
        : join(home, 'google-chrome')
  for (const directory of ['Default', 'Profile 2']) {
    mkdirSync(join(root, directory), { recursive: true })
    writeFileSync(join(root, directory, 'Cookies'), '')
  }
  vi.stubEnv('HOME', home)
  vi.stubEnv('LOCALAPPDATA', home)
  vi.stubEnv('XDG_CONFIG_HOME', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

function writeProfiles(info_cache: Record<string, { name: string }>): void {
  writeFileSync(join(root, 'Local State'), JSON.stringify({ profile: { info_cache } }))
}

it('refreshes the saved directory through a rename and refuses it after removal', async () => {
  writeProfiles({ Default: { name: 'Work' }, 'Profile 2': { name: 'Work' } })
  const original = await browserCookieImportSource({
    browserFamily: 'chrome',
    browserProfile: 'Profile 2'
  })
  if ('reason' in original) {
    throw new Error(original.reason)
  }
  const saved = original.importedSource()
  const selection = { refreshSourceId: saved.chromeProfile!.id }
  writeProfiles({ Default: { name: 'Work' }, 'Profile 2': { name: 'Renamed' } })
  const refreshed = await browserCookieImportSource(selection, saved)
  if ('reason' in refreshed) {
    throw new Error(refreshed.reason)
  }
  expect(refreshed.importedSource()).toMatchObject({
    profileName: 'Renamed',
    chromeProfile: { directory: 'Profile 2' }
  })

  writeProfiles({ Default: { name: 'Work' } })
  expect(await browserCookieImportSource(selection, saved)).toMatchObject({
    ok: false,
    reasonCode: 'savedChromeProfileUnavailable'
  })
})

it('keeps the manual import badge for the legacy Default fallback without a refresh token', async () => {
  writeProfiles({})
  const source = await browserCookieImportSource({ browserFamily: 'chrome' })
  if ('reason' in source) {
    throw new Error(source.reason)
  }
  expect(source.importedSource()).toMatchObject({ browserFamily: 'chrome', profileName: 'Default' })
  expect(source.importedSource().chromeProfile).toBeUndefined()
})
