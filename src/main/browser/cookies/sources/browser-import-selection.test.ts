import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  detectInstalledBrowsers,
  resolveBrowserImportSelection,
  selectBrowserProfile
} from './browser-cookie-detection'
import * as profiles from './browser-cookie-source-profiles'

const chrome: profiles.DetectedBrowser = {
  family: 'chrome',
  label: 'Chrome',
  profiles: [
    { directory: 'Default', name: 'Work' },
    { directory: 'Profile 2', name: 'Work' }
  ],
  selectedProfile: 'Profile 2',
  cookiesPath: 'unused'
}

afterEach(() => {
  vi.restoreAllMocks()
})

it('refreshes the chosen Chrome directory even when the default has its old display name', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-chrome-selection-'))
  try {
    vi.spyOn(profiles, 'browserRootPath').mockReturnValue(root)
    for (const profile of chrome.profiles) {
      mkdirSync(join(root, profile.directory))
      writeFileSync(join(root, profile.directory, 'Cookies'), '')
    }
    const writeProfiles = (info_cache: Record<string, { name: string }>) =>
      writeFileSync(join(root, 'Local State'), JSON.stringify({ profile: { info_cache } }))
    writeProfiles({ Default: { name: 'Work' }, 'Profile 2': { name: 'Renamed' } })
    const saved = profiles.importedBrowserProfileSource(chrome)
    const refresh = { refreshSourceId: saved.chromeProfile!.id }

    const selection = resolveBrowserImportSelection(refresh, saved)
    if ('reason' in selection) {
      throw new Error(selection.reason)
    }
    expect(selectBrowserProfile(detectInstalledBrowsers('chrome')[0], selection)).toMatchObject({
      selectedProfile: 'Profile 2'
    })

    // A removed profile can leave a readable database behind.
    writeProfiles({ Default: { name: 'Work' } })
    expect(selectBrowserProfile(detectInstalledBrowsers('chrome')[0], selection)).toMatchObject({
      ok: false,
      reasonCode: 'savedChromeProfileUnavailable'
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('refuses a refresh for a different destination with the same Chrome directory', () => {
  const original = profiles.importedBrowserProfileSource(chrome)
  const other = profiles.importedBrowserProfileSource(chrome)
  expect(
    resolveBrowserImportSelection({ refreshSourceId: original.chromeProfile!.id }, other)
  ).toMatchObject({
    ok: false,
    reasonCode: 'savedChromeProfileUnavailable'
  })
})

it('refreshes Default only while Chrome lists it, even when its old database remains', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-chrome-default-'))
  try {
    vi.spyOn(profiles, 'browserRootPath').mockReturnValue(root)
    mkdirSync(join(root, 'Default'))
    writeFileSync(join(root, 'Default', 'Cookies'), '')
    const localState = join(root, 'Local State')
    writeFileSync(localState, JSON.stringify({ profile: { info_cache: { Default: {} } } }))
    const refresh = { browserFamily: 'chrome', browserProfile: 'Default', refresh: true } as const
    expect(selectBrowserProfile(detectInstalledBrowsers('chrome')[0], refresh)).toMatchObject({
      selectedProfile: 'Default'
    })

    writeFileSync(localState, JSON.stringify({ profile: { info_cache: {} } }))
    const [detected] = detectInstalledBrowsers('chrome')
    expect(selectBrowserProfile(detected, { browserFamily: 'chrome' })).toMatchObject({
      selectedProfile: 'Default'
    })
    expect(selectBrowserProfile(detected, refresh)).toMatchObject({
      ok: false,
      reasonCode: 'savedChromeProfileUnavailable'
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
