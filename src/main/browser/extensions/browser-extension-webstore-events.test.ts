import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'

const state = vi.hoisted(() => {
  const contents: unknown[] = []
  return { contents, enabled: new Map<string, string[]>() }
})

vi.mock('electron', () => ({
  webContents: { getAllWebContents: () => state.contents }
}))
vi.mock('./browser-extension-api-host', () => ({
  getBrowserExtensionProfileIdForSession: (session: { profileId: string }) => session.profileId
}))
vi.mock('../browser-session-registry', () => ({
  browserSessionRegistry: {
    getEnabledExtensionIds: (profileId: string) => state.enabled.get(profileId) ?? []
  }
}))

const { notifyChromeWebStoreInstalled, notifyChromeWebStoreUninstalled } =
  await import('./browser-extension-webstore-events')

const extension: InstalledBrowserExtension = {
  id: 'a'.repeat(32),
  name: 'Example',
  version: '1',
  source: 'webstore',
  path: '/extensions/example',
  iconPath: null,
  permissions: [],
  hostPermissions: [],
  optionsPage: null
}

function storePage(profileId: string, url = 'https://chromewebstore.google.com/') {
  const send = vi.fn()
  const contents = {
    isDestroyed: () => false,
    getType: () => 'webview',
    session: { profileId },
    mainFrame: { url, send }
  }
  state.contents.push(contents)
  return send
}

beforeEach(() => {
  state.contents = []
  state.enabled.clear()
})

describe('Chrome Web Store profile events', () => {
  it('reports an installation only to profiles where the extension is enabled', () => {
    const enabledPage = storePage('personal')
    const disabledPage = storePage('work')
    const unrelatedPage = storePage('personal', 'https://example.com/')
    state.enabled.set('personal', [extension.id])

    notifyChromeWebStoreInstalled(extension)

    expect(enabledPage).toHaveBeenCalledWith(expect.any(String), {
      event: 'onInstalled',
      args: [expect.objectContaining({ id: extension.id, enabled: true })]
    })
    expect(disabledPage).not.toHaveBeenCalled()
    expect(unrelatedPage).not.toHaveBeenCalled()
  })

  it('reports a global uninstall to store pages in every profile', () => {
    const personal = storePage('personal')
    const work = storePage('work')

    notifyChromeWebStoreUninstalled(extension.id)

    for (const send of [personal, work]) {
      expect(send).toHaveBeenCalledWith(expect.any(String), {
        event: 'onUninstalled',
        args: [extension.id]
      })
    }
  })
})
