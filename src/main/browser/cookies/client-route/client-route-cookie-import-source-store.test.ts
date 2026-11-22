import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { deriveBrowserRoutePartitionStorageScope } from '../../routing/partitions/browser-route-identity'

let userData: string
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

it('persists concurrent imports separately for each Orca profile and pairing', async () => {
  userData = await mkdtemp(join(tmpdir(), 'orca-import-sources-'))
  try {
    await writeFile(
      join(userData, 'client-route-cookie-import-sources.json'),
      JSON.stringify({
        'server\u0000legacy': {
          browserFamily: 'chrome',
          authority: 'first-pairing',
          profileName: 'Legacy',
          importedAt: 1,
          chromeProfile: { directory: 'Default', id: 'unbound' }
        }
      })
    )
    const { openClientRouteCookieImportSources } =
      await import('./client-route-cookie-import-source-store')
    const route = (orcaProfileId: string, authorityConnectionIdentity = 'first-pairing') => ({
      storageScope: deriveBrowserRoutePartitionStorageScope({
        orcaProfileId,
        environmentId: 'server'
      }),
      authorityConnectionIdentity
    })
    const [work, personal] = await Promise.all([
      openClientRouteCookieImportSources(route('alpha')),
      openClientRouteCookieImportSources(route('alpha'))
    ])
    expect(work.sources.legacy).toBeUndefined()
    work.record('work', {
      browserFamily: 'chrome',
      importedAt: 2,
      chromeProfile: { directory: 'Profile 2', id: 'work-import' }
    })
    personal.record('personal', { browserFamily: 'firefox', importedAt: 3 })

    const otherProfile = await openClientRouteCookieImportSources(route('beta'))
    expect(otherProfile.sources.work).toBeUndefined()
    otherProfile.record('work', {
      browserFamily: 'chrome',
      importedAt: 4,
      chromeProfile: { directory: 'Default', id: 'beta-import' }
    })
    vi.resetModules()
    const { openClientRouteCookieImportSources: reopen } =
      await import('./client-route-cookie-import-source-store')
    const original = await reopen(route('alpha'))
    expect(original.sources.work?.chromeProfile?.id).toBe('work-import')
    expect(original.sources.personal?.browserFamily).toBe('firefox')
    expect((await reopen(route('beta'))).sources.work?.chromeProfile?.id).toBe('beta-import')
    expect((await reopen(route('alpha', 'second-pairing'))).sources).toEqual({})
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})
