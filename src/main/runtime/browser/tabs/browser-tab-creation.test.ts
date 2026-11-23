import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  admitBrowserPageAttach,
  associateBrowserPageAttach,
  prepareBrowserPageAttach,
  startBrowserPageAttach
} from '../../../browser/guest-lifecycle/browser-page-memory'
import { RuntimeBrowserTabCreation } from './browser-tab-creation'

vi.mock('electron', () => ({ app: { on: vi.fn(), off: vi.fn() }, session: {} }))
vi.mock('../../../browser/extensions/profile-sessions/browser-extension-page-start', () => ({
  whenBrowserExtensionsReadyForPage: () => null
}))
vi.mock('../../../browser/sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: { resolveKnownPartition: () => 'persist:orca-browser' }
}))
vi.mock('../../../ipc/browser/browser-tab-registration-wait', () => ({
  waitForTabRegistration: () => Promise.resolve()
}))
vi.mock('./browser-tab-create-publication', () => ({
  resolveBrowserTabCreateFocus: () => ({ focusesHost: false }),
  publishCreatedBrowserSessionTab: () => Promise.resolve()
}))
vi.mock('../client-pages/browser-client-page-opening', () => ({}))
vi.mock('../client-pages/server-agent-tab-placement', () => ({}))

const RENDERER_ID = 7
const PARTITION = 'persist:orca-browser'
const loads: string[] = []
let guest: ReturnType<typeof fakeGuest>

function fakeGuest() {
  const emitter = new EventEmitter()
  let current = ''
  return Object.assign(emitter, {
    id: 42,
    hostWebContents: { id: RENDERER_ID },
    getType: () => 'webview',
    isDestroyed: () => false,
    getURL: () => current,
    getTitle: () => 'Page',
    loadURL: (url: string) => {
      loads.push(url)
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          current = url
          emitter.emit('did-finish-load')
          resolve()
        }, 5)
      )
    }
  })
}

vi.mock('./browser-tab-renderer-create', () => ({
  // The renderer opens the tab at its URL, so main's attach makes the first load.
  createBrowserTabInRenderer: async (_host: unknown, url: string) => {
    const browserPageId = 'page-1'
    guest = fakeGuest()
    const marker = prepareBrowserPageAttach(browserPageId, RENDERER_ID, PARTITION, url)
    admitBrowserPageAttach(marker, RENDERER_ID, PARTITION)
    associateBrowserPageAttach(guest as unknown as Electron.WebContents)
    startBrowserPageAttach(guest as unknown as Electron.WebContents)
    return { browserPageId }
  }
}))

describe('RuntimeBrowserTabCreation', () => {
  it('loads a created tab URL once and reports where it landed', async () => {
    const notifyRendererNavigation = vi.fn()
    const goto = vi.fn(async (url: string) => {
      await guest.loadURL(url)
      return { url: guest.getURL(), title: guest.getTitle() }
    })
    const creation = new RuntimeBrowserTabCreation(
      { getAvailableAuthoritativeWindowId: () => 1 } as never,
      { requireAgentBrowserBridge: () => ({ goto }) as never, notifyRendererNavigation }
    )

    await creation.browserTabCreate({ url: 'https://example.com/callback?code=1' })

    expect(loads).toEqual(['https://example.com/callback?code=1'])
    expect(notifyRendererNavigation).toHaveBeenCalledWith(
      'page-1',
      'https://example.com/callback?code=1',
      'Page'
    )
  })
})
