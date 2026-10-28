import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type * as DownloadModule from './browser-extension-webstore-download'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  records: new Map<string, Record<string, unknown>>(),
  download: vi.fn()
}))

vi.mock('electron', () => ({ net: { fetch: mocks.fetch }, app: { getPath: () => '/tmp' } }))
vi.mock('./browser-extension-support', () => ({ isBrowserExtensionSupportEnabled: () => true }))
vi.mock('./browser-extension-install-store', () => ({
  getBrowserExtensionInstallStore: () => ({
    list: () => [...mocks.records.values()],
    get: (id: string) => mocks.records.get(id) ?? null
  })
}))
vi.mock('./browser-extension-webstore-download', async (importOriginal) => ({
  ...(await importOriginal<typeof DownloadModule>()),
  downloadWebStoreCrx: mocks.download
}))
vi.mock('./browser-extension-webstore-install', () => ({
  withBrowserExtensionLock: (_id: string, action: () => Promise<unknown>) => action(),
  isBrowserExtensionBusy: () => false
}))

const { checkForBrowserExtensionUpdates, compareExtensionVersions, parseOmahaUpdateResponse } =
  await import('./browser-extension-webstore-updater')

const UBOL = 'ddkjiahejlhfcafbddmgiahcphecmpfh'
const BITWARDEN = 'nngceckbapebfimnlniiiahkandclblb'

/** Trimmed from a real update.googleapis.com reply (2026-10-19). */
const RESPONSE = `)]}'
${JSON.stringify({
  response: {
    protocol: '3.1',
    app: [
      {
        appid: UBOL,
        status: 'ok',
        updatecheck: {
          status: 'ok',
          urls: { url: [{ codebase: 'https://clients2.googleusercontent.com/crx/blobs/AZPV/' }] },
          manifest: {
            version: '2026.1018.2229',
            packages: {
              package: [
                {
                  hash_sha256: '559d10ef7dcb96bc4e812de6b3ff0c2e6c7abca578324d8d7afd7d8cf78a6dd7',
                  size: 9145194,
                  name: 'DDKJIAHEJLHFCAFBDDMGIAHCPHECMPFH_2026_1018_2229_0.crx'
                }
              ]
            }
          }
        }
      },
      { appid: BITWARDEN, status: 'ok', updatecheck: { status: 'noupdate' } }
    ]
  }
})}`

describe('compareExtensionVersions', () => {
  it('compares dotted integers numerically', () => {
    expect(compareExtensionVersions('2026.1018.2229', '2026.1018.2228')).toBe(1)
    expect(compareExtensionVersions('1.10', '1.9')).toBe(1)
    expect(compareExtensionVersions('1.0', '1')).toBe(0)
    expect(compareExtensionVersions('1.0.0.1', '1.0.1')).toBe(-1)
  })
})

describe('parseOmahaUpdateResponse', () => {
  it('offers newer versions with the package URL, size and checksum', () => {
    const installed = new Map([
      [UBOL, '2026.1001.1'],
      [BITWARDEN, '2026.1.0']
    ])
    expect(parseOmahaUpdateResponse(RESPONSE, installed)).toEqual([
      {
        extensionId: UBOL,
        version: '2026.1018.2229',
        url: 'https://clients2.googleusercontent.com/crx/blobs/AZPV/DDKJIAHEJLHFCAFBDDMGIAHCPHECMPFH_2026_1018_2229_0.crx',
        sha256: '559d10ef7dcb96bc4e812de6b3ff0c2e6c7abca578324d8d7afd7d8cf78a6dd7',
        size: 9145194
      }
    ])
  })

  it('skips versions that are not newer, unknown apps and malformed replies', () => {
    expect(parseOmahaUpdateResponse(RESPONSE, new Map([[UBOL, '2026.1018.2229']]))).toEqual([])
    expect(parseOmahaUpdateResponse(RESPONSE, new Map())).toEqual([])
    expect(parseOmahaUpdateResponse('not json', new Map([[UBOL, '1']]))).toEqual([])
  })

  it('drops download URLs outside Google hosts', () => {
    const hostile = RESPONSE.replace(
      'https://clients2.googleusercontent.com/crx/blobs/AZPV/',
      'https://evil.tld/'
    )
    expect(parseOmahaUpdateResponse(hostile, new Map([[UBOL, '1']]))).toEqual([])
  })
})

describe('checkForBrowserExtensionUpdates', () => {
  it('does not reinstall an extension removed while the update check was running', async () => {
    const path = mkdtempSync(join(tmpdir(), 'orca-updater-'))
    writeFileSync(join(path, 'manifest.json'), JSON.stringify({ permissions: ['storage'] }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.records.set(UBOL, {
      id: UBOL,
      name: 'uBlock Origin Lite',
      version: '2026.1001.1',
      path,
      source: 'webstore'
    })
    mocks.fetch.mockImplementationOnce(async () => {
      mocks.records.delete(UBOL)
      return new Response(RESPONSE)
    })
    await checkForBrowserExtensionUpdates()
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(mocks.download).not.toHaveBeenCalled()
    rmSync(path, { recursive: true, force: true })
  })
})
