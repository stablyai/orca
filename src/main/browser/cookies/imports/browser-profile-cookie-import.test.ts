import { expect, it, vi } from 'vitest'
import type { BrowserSessionProfile } from '../../../../shared/browser/workspaces/browser-workspace-types'
import { browserCookieImportFailure } from '../../../../shared/browser/cookies/browser-cookie-import-failure-copy'
import { importCookiesIntoBrowserProfile } from './browser-profile-cookie-import'
import { withCookieMutationLock } from '../mutation/cookie-mutation-lock'

const { jar, registry } = vi.hoisted(() => ({
  jar: {},
  registry: {
    getProfile: vi.fn(),
    updateProfileSource: vi.fn()
  }
}))
vi.mock('electron', () => ({ session: { fromPartition: () => jar } }))
vi.mock('../../sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: registry
}))

it('rejects a queued refresh after a manual import replaces the same jar’s source', async () => {
  const originalSource = {
    browserFamily: 'chrome',
    chromeProfile: { directory: 'Default', id: 'profile-a' },
    importedAt: 1
  } as const
  const newSource = { browserFamily: 'chrome', profileName: 'Work', importedAt: 2 } as const
  const profile: BrowserSessionProfile = {
    id: 'default',
    label: 'Default',
    scope: 'default',
    partition: 'persist:orca-browser',
    source: originalSource
  }
  let current = profile
  registry.getProfile.mockImplementation(() => current)
  registry.updateProfileSource.mockImplementation(
    (_id, source: BrowserSessionProfile['source']) => {
      current = { ...current, source }
    }
  )
  let jarValue = 'a'
  const started = Promise.withResolvers<void>()
  const write = Promise.withResolvers<void>()
  const manual = importCookiesIntoBrowserProfile(profile, () => ({
    importInto: () =>
      withCookieMutationLock(jar, async () => {
        started.resolve()
        await write.promise
        jarValue = 'b'
        return {
          ok: true,
          summary: { importedCookies: 1, skippedCookies: 0, totalCookies: 1, domains: [] }
        }
      }),
    importedSource: () => newSource
  }))
  await started.promise
  const refresh = importCookiesIntoBrowserProfile(profile, (source) =>
    source?.chromeProfile?.id === 'profile-a'
      ? {
          importInto: async () => {
            jarValue = 'a'
            return {
              ok: true,
              summary: { importedCookies: 1, skippedCookies: 0, totalCookies: 1, domains: [] }
            }
          },
          importedSource: () => originalSource
        }
      : browserCookieImportFailure('savedChromeProfileUnavailable')
  )
  write.resolve()
  await expect(manual).resolves.toMatchObject({ ok: true })
  await expect(refresh).resolves.toMatchObject({
    ok: false,
    reasonCode: 'savedChromeProfileUnavailable'
  })
  expect(jarValue).toBe('b')
  expect(current.source).toEqual(newSource)

  await expect(
    importCookiesIntoBrowserProfile(profile, () => ({
      importInto: async () => ({
        ok: true,
        summary: { importedCookies: 0, skippedCookies: 1, totalCookies: 1, domains: [] }
      }),
      importedSource: () => originalSource
    }))
  ).resolves.toMatchObject({ ok: true })
  expect(current.source).toEqual(newSource)
})
