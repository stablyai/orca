import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '/nonexistent' },
  webContents: {
    fromId: (id: number) => (id === TAB ? { getURL: () => 'https://page.example/start' } : null)
  }
}))

const { grantBrowserExtensionActiveTab } = await import('./browser-extension-active-tab')
const { canExtensionAccessRequest } = await import('./browser-extension-request-host-access')

const TAB = 5
const ID = 'a'.repeat(32)
const API_ONLY = (url: string): boolean => url.startsWith('https://api.example/')

describe('canExtensionAccessRequest', () => {
  it('gives an activeTab grant the tab page origin only', () => {
    const noHosts = (): boolean => false
    const request = { initiator: 'https://page.example', tabId: TAB, type: 'xmlhttprequest' }
    grantBrowserExtensionActiveTab(
      {
        id: ID,
        name: '',
        path: '',
        url: '',
        version: '1',
        manifest: { permissions: ['activeTab'] }
      },
      TAB
    )

    expect(
      canExtensionAccessRequest(ID, { ...request, url: 'https://page.example/api' }, noHosts)
    ).toBe(true)
    expect(
      canExtensionAccessRequest(ID, { ...request, url: 'https://bank.example/account' }, noHosts)
    ).toBe(false)
  })

  it('needs the initiator for subresources but not for navigations', () => {
    const request = {
      url: 'https://api.example/data',
      initiator: 'https://private.example',
      tabId: -1
    }

    expect(canExtensionAccessRequest(ID, { ...request, type: 'xmlhttprequest' }, API_ONLY)).toBe(
      false
    )
    expect(canExtensionAccessRequest(ID, { ...request, type: 'main_frame' }, API_ONLY)).toBe(true)
    expect(
      canExtensionAccessRequest(
        ID,
        { ...request, initiator: 'https://api.example', type: 'xmlhttprequest' },
        API_ONLY
      )
    ).toBe(true)
  })
})
