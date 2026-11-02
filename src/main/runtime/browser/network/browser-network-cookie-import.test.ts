import { beforeEach, describe, expect, it, vi } from 'vitest'

const browserSessionRegistryMock = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getDefaultProfile: vi.fn(),
  updateProfileSource: vi.fn()
}))
const importCookiesFromFileMock = vi.hoisted(() => vi.fn())

vi.mock('../../../browser/sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: browserSessionRegistryMock
}))

vi.mock('../../../browser/cookies/imports/import-cookie-file', () => ({
  importCookiesFromFile: importCookiesFromFileMock
}))

import { RuntimeBrowserNetwork } from './browser-network'

describe('RuntimeBrowserNetwork browserCookieImport', () => {
  beforeEach(() => {
    browserSessionRegistryMock.getProfile.mockReset()
    browserSessionRegistryMock.getDefaultProfile.mockReset()
    browserSessionRegistryMock.updateProfileSource.mockReset()
    importCookiesFromFileMock.mockReset()
  })

  it('resolves a synthetic default profile and records the resolved profile id', async () => {
    browserSessionRegistryMock.getProfile.mockReturnValue(null)
    browserSessionRegistryMock.getDefaultProfile.mockReturnValue({
      id: 'default',
      partition: 'persist:orca-browser'
    })
    importCookiesFromFileMock.mockResolvedValue({ ok: true, imported: 2, skipped: 0 })

    const network = new RuntimeBrowserNetwork({
      requireAgentBrowserBridge: () => {
        throw new Error('unused')
      },
      resolveBrowserCommandTarget: async () => {
        throw new Error('unused')
      }
    })

    await expect(network.browserCookieImport({ file: '/tmp/cookies.json' })).resolves.toEqual({
      ok: true,
      imported: 2,
      skipped: 0,
      profileId: 'default'
    })

    expect(browserSessionRegistryMock.getDefaultProfile).toHaveBeenCalled()
    expect(importCookiesFromFileMock).toHaveBeenCalledWith(
      '/tmp/cookies.json',
      'persist:orca-browser'
    )
    expect(browserSessionRegistryMock.updateProfileSource).toHaveBeenCalledWith('default', {
      browserFamily: 'manual',
      importedAt: expect.any(Number)
    })
  })
})
