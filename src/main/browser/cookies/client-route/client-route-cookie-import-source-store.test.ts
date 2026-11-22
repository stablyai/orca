import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

let userData: string
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

it('persists imports from concurrent readers and binds refresh to the original pairing', async () => {
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
    const [work, personal] = await Promise.all([
      openClientRouteCookieImportSources('server', 'first-pairing'),
      openClientRouteCookieImportSources('server', 'first-pairing')
    ])
    work.record('work', {
      browserFamily: 'chrome',
      importedAt: 2,
      chromeProfile: { directory: 'Profile 2', id: 'work-import' }
    })
    personal.record('personal', { browserFamily: 'firefox', importedAt: 3 })

    vi.resetModules()
    const { openClientRouteCookieImportSources: reopen } =
      await import('./client-route-cookie-import-source-store')
    const original = await reopen('server', 'first-pairing')
    expect(original.sources.work?.chromeProfile?.id).toBe('work-import')
    expect(original.sources.personal?.browserFamily).toBe('firefox')
    const pairedAgain = await reopen('server', 'second-pairing')
    expect(Object.keys(pairedAgain.sources)).toEqual(['legacy'])
    expect(pairedAgain.sources.legacy?.profileName).toBe('Legacy')
    expect(pairedAgain.sources.legacy?.chromeProfile).toBeUndefined()
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})
