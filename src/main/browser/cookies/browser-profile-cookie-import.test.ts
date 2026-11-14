import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DetectedBrowser } from './sources/browser-cookie-source-profiles'

const mocks = vi.hoisted(() => ({ root: '', import: vi.fn(), detect: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => mocks.root },
  session: { fromPartition: () => ({}) }
}))
vi.mock('./browser-cookie-import', () => ({ importCookiesFromBrowser: mocks.import }))
vi.mock('./sources/browser-cookie-detection', () => ({
  detectInstalledBrowsers: mocks.detect,
  selectBrowserProfile: (browser: DetectedBrowser, directory: string) => ({
    ...browser,
    cookiesPath: `/chrome/${directory}/Cookies`,
    selectedProfile: directory
  })
}))
import { browserSessionRegistry } from '../sessions/profiles/browser-session-registry'
import { reimportBrowserCookiesOnLaunch } from './browser-profile-cookie-import'

function detectChrome(profileNames: [string, string]) {
  mocks.detect.mockReturnValue([
    {
      family: 'chrome',
      label: 'Google Chrome',
      cookiesPath: '/chrome/Default/Cookies',
      selectedProfile: 'Default',
      profiles: [
        { name: profileNames[0], directory: 'Default' },
        { name: profileNames[1], directory: 'Profile 1' }
      ]
    }
  ])
}

beforeEach(() => {
  mocks.root = mkdtempSync(join(tmpdir(), 'orca-cookie-reimport-'))
  browserSessionRegistry.configureForOrcaProfile({
    orcaProfileId: 'orca',
    profileDirectory: mocks.root
  })
  mocks.import.mockResolvedValue({ ok: true, profileId: '', summary: {} })
})

afterEach(() => {
  vi.clearAllMocks()
  rmSync(mocks.root, { recursive: true, force: true })
})

it('re-imports a profile from the browser profile it was imported from', async () => {
  detectChrome(['Work', 'Work'])
  browserSessionRegistry.updateProfileSource('default', {
    browserFamily: 'chrome',
    profileName: 'Work',
    profileDirectory: 'Profile 1',
    importedAt: 1
  })

  await reimportBrowserCookiesOnLaunch({ browserCookieReimportOnLaunch: false })
  expect(mocks.import).not.toHaveBeenCalled()

  await reimportBrowserCookiesOnLaunch({ browserCookieReimportOnLaunch: true })

  const partition = browserSessionRegistry.getDefaultProfile().partition
  expect(mocks.import).toHaveBeenCalledWith(
    expect.objectContaining({ cookiesPath: '/chrome/Profile 1/Cookies' }),
    partition,
    {}
  )
  expect(browserSessionRegistry.getDefaultProfile().source).toMatchObject({
    browserFamily: 'chrome',
    profileName: 'Work',
    profileDirectory: 'Profile 1'
  })
  expect(browserSessionRegistry.getDefaultProfile().source?.importedAt).toBeGreaterThan(1)
})

it('finds a source saved without its directory only by a unique profile name', async () => {
  browserSessionRegistry.updateProfileSource('default', {
    browserFamily: 'chrome',
    profileName: 'Work',
    importedAt: 1
  })

  detectChrome(['Work', 'Work'])
  await reimportBrowserCookiesOnLaunch({ browserCookieReimportOnLaunch: true })
  expect(mocks.import).not.toHaveBeenCalled()

  detectChrome(['Personal', 'Work'])
  await reimportBrowserCookiesOnLaunch({ browserCookieReimportOnLaunch: true })
  expect(mocks.import).toHaveBeenCalledWith(
    expect.objectContaining({ cookiesPath: '/chrome/Profile 1/Cookies' }),
    browserSessionRegistry.getDefaultProfile().partition,
    {}
  )
  expect(browserSessionRegistry.getDefaultProfile().source?.profileDirectory).toBe('Profile 1')
})
