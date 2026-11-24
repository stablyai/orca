import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
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
          profileName: 'Legacy',
          importedAt: 1,
          chromeProfile: { directory: 'Default', id: 'unbound' }
        }
      })
    )
    const { openClientRouteCookieImportSources } =
      await import('./client-route-cookie-import-source-store')
    const route = (orcaProfileId: string, authorityConnectionIdentity = 'first-pairing') => ({
      environmentId: 'server',
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
    expect(work.sources.legacy).toEqual({
      browserFamily: 'chrome',
      profileName: 'Legacy',
      importedAt: 1
    })
    await Promise.all([
      work.record('work', {
        browserFamily: 'chrome',
        importedAt: 2,
        chromeProfile: { directory: 'Profile 2', id: 'work-import' }
      }),
      personal.record('personal', { browserFamily: 'firefox', importedAt: 3 })
    ])

    const otherProfile = await openClientRouteCookieImportSources(route('beta'))
    expect(otherProfile.sources.work).toBeUndefined()
    await otherProfile.record('work', {
      browserFamily: 'chrome',
      importedAt: 4,
      chromeProfile: { directory: 'Default', id: 'beta-import' }
    })
    vi.resetModules()
    const {
      openClientRouteCookieImportSources: reopen,
      forgetClientRouteCookieImportSource,
      clientRouteCookieImportSources,
      recordClientRouteCookieImportSource,
      sshCookieImportRoute
    } = await import('./client-route-cookie-import-source-store')
    const original = await reopen(route('alpha'))
    expect(original.sources.work?.chromeProfile?.id).toBe('work-import')
    expect(original.sources.personal?.browserFamily).toBe('firefox')
    expect((await reopen(route('beta'))).sources.work?.chromeProfile?.id).toBe('beta-import')
    expect((await reopen(route('alpha', 'second-pairing'))).sources.work).toBeUndefined()

    const storePath = join(userData, 'client-route-cookie-import-sources.json')
    const savedPath = `${storePath}.saved`
    await rename(storePath, savedPath)
    await mkdir(storePath)
    await expect(
      original.record('work', { browserFamily: 'firefox', importedAt: 5 })
    ).rejects.toThrow()
    expect((await reopen(route('alpha'))).sources.work?.chromeProfile?.id).toBe('work-import')
    await rm(storePath, { recursive: true })
    await rename(savedPath, storePath)

    const sshRoute = sshCookieImportRoute('development')
    await recordClientRouteCookieImportSource({
      route: sshRoute,
      profileId: 'work',
      source: original.sources.work
    })
    expect((await clientRouteCookieImportSources(sshRoute)).work).toEqual({
      browserFamily: 'chrome',
      importedAt: 2,
      profileName: undefined
    })
    expect((await reopen(route('alpha'))).sources.work?.chromeProfile?.id).toBe('work-import')
    await forgetClientRouteCookieImportSource({ route: sshRoute, profileId: 'work' })
    expect((await clientRouteCookieImportSources(sshRoute)).work).toBeUndefined()

    await forgetClientRouteCookieImportSource({ route: route('alpha'), profileId: 'work' })
    await forgetClientRouteCookieImportSource({ route: route('alpha'), profileId: 'legacy' })
    vi.resetModules()
    const { openClientRouteCookieImportSources: afterClear } =
      await import('./client-route-cookie-import-source-store')
    expect((await afterClear(route('alpha'))).sources.work).toBeUndefined()
    expect((await afterClear(route('alpha'))).sources.legacy).toBeUndefined()
    expect((await afterClear(route('alpha'))).sources.personal?.browserFamily).toBe('firefox')
    expect((await afterClear(route('beta'))).sources.work?.chromeProfile?.id).toBe('beta-import')
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})
