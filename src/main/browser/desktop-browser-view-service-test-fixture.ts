import { EventEmitter } from 'node:events'
import type { BrowserWindow, View, WebContents } from 'electron'
import { vi, type Mock } from 'vitest'
import type {
  DesktopBrowserViewCapture,
  DesktopBrowserViewCreateArgs,
  DesktopBrowserViewEvent
} from '../../shared/desktop-browser-view-protocol'
import {
  createOwnedViewFixture,
  createOwnedViewHost
} from './desktop-owned-browser-view-test-fixture'
import {
  DesktopOwnedBrowserViewAdmission,
  type DesktopOwnedBrowserViewRecord
} from './desktop-owned-browser-view-admission'
import { DesktopBrowserViewService } from './desktop-browser-view-service'
import { createDesktopBrowserContainerFixture } from './desktop-browser-container-test-fixture'

type OwnedViewFixture = ReturnType<typeof createOwnedViewFixture>

type ServiceFixtureGuest = OwnedViewFixture['guest'] & {
  getURL: () => string
  getTitle: () => string
  isLoading: () => boolean
  getZoomLevel: () => number
  setZoomLevel: Mock<(value: number) => void>
  isFocused: () => boolean
  focus: Mock<() => void>
  loadURL: Mock<(url: string) => Promise<void>>
  navigationHistory: {
    canGoBack: () => boolean
    canGoForward: () => boolean
    goBack: Mock<() => void>
    goForward: Mock<() => void>
  }
  reload: Mock<() => void>
  reloadIgnoringCache: Mock<() => void>
  stop: Mock<() => void>
  findInPage: Mock<() => number>
  stopFindInPage: Mock<() => void>
}

export type DesktopBrowserViewServiceFixture = {
  service: DesktopBrowserViewService
  sender: WebContents
  senderShape: EventEmitter & {
    id: number
    isDestroyed: () => boolean
    getZoomFactor: () => number
  }
  guest: ServiceFixtureGuest
  native: OwnedViewFixture
  owner: BrowserWindow
  container: View
  host: ReturnType<typeof createOwnedViewHost>
  manager: {
    registerOwnedView: Mock<(record: DesktopOwnedBrowserViewRecord) => boolean>
    unregisterGuest: Mock<(pageId: string) => boolean>
    getGuestWebContentsId: (pageId: string) => number | null
  }
  registered: Map<string, number>
  events: DesktopBrowserViewEvent[]
  onError: Mock<(...args: unknown[]) => void>
  retirePage: Mock<() => Promise<void>>
  captureViewport: Mock<
    (record: DesktopOwnedBrowserViewRecord) => Promise<DesktopBrowserViewCapture>
  >
  onRegistered: Mock<() => void>
  args: DesktopBrowserViewCreateArgs
  order: string[]
  properties: { url: string; zoom: number; focused: boolean; loading: boolean }
}

export function createDesktopBrowserViewServiceFixture({
  autoDestroy = true
}: { autoDestroy?: boolean } = {}): DesktopBrowserViewServiceFixture {
  const native = createOwnedViewFixture({ autoDestroy })
  const order: string[] = []
  const properties = { url: '', zoom: 0, focused: false, loading: false }
  const guest = Object.assign(native.guest, {
    getURL: () => properties.url,
    getTitle: () => 'Fixture title',
    isLoading: () => properties.loading,
    getZoomLevel: () => properties.zoom,
    setZoomLevel: vi.fn((value: number) => {
      properties.zoom = value
    }),
    isFocused: () => properties.focused,
    focus: vi.fn(() => {
      properties.focused = true
    }),
    loadURL: vi.fn(async (url: string) => {
      order.push('load')
      properties.url = url
      properties.loading = true
      guest.emit('did-start-loading')
    }),
    navigationHistory: {
      canGoBack: () => true,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn()
    },
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    stop: vi.fn(),
    findInPage: vi.fn(() => 12),
    stopFindInPage: vi.fn()
  })
  const senderShape = Object.assign(new EventEmitter(), {
    id: 8,
    isDestroyed: () => false,
    getZoomFactor: () => 2,
    focus: vi.fn(() => {
      properties.focused = false
    })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: service tests supply all renderer identity, event, zoom and focus APIs they exercise.
  const sender = senderShape as unknown as WebContents
  const host = createOwnedViewHost()
  const ownerShape = {
    ...host,
    webContents: sender,
    getContentBounds: () => ({ x: 20, y: 40, width: 900, height: 650 })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service uses only this host's contents, child views, destruction state and content bounds.
  const owner = ownerShape as unknown as BrowserWindow
  const registered = new Map<string, number>()
  const registerOwnedView = vi.fn((record: DesktopOwnedBrowserViewRecord) => {
    order.push('register')
    registered.set(record.browserPageId, record.webContents.id)
    return true
  })
  const unregisterGuest = vi.fn((pageId: string) => registered.delete(pageId))
  const manager = {
    registerOwnedView,
    unregisterGuest,
    getGuestWebContentsId: (pageId: string) => registered.get(pageId) ?? null
  }
  const admission = new DesktopOwnedBrowserViewAdmission({
    isKnownPartition: (profile) => (profile === 'missing' ? null : 'persist:fixture'),
    getSession: () => guest.session,
    createView: () => native.view,
    attachPolicies: () => {
      order.push('policy')
    }
  })
  const events: DesktopBrowserViewEvent[] = []
  const onError = vi.fn()
  const retirePage = vi.fn(async () => {
    order.push('retire')
  })
  const onRegistered = vi.fn(() => {
    order.push('ready')
  })
  const captureViewport = vi.fn(async (_record: DesktopOwnedBrowserViewRecord) => ({
    dataUrl: 'data:image/png;base64,cGl4ZWxz',
    width: 800,
    height: 600
  }))
  const container = createDesktopBrowserContainerFixture()
  const service = new DesktopBrowserViewService({
    admission,
    manager,
    resolveOwner: () => owner,
    createContainer: () => container,
    publish: (_sender, event) => {
      events.push(event)
    },
    onRegistered,
    retirePage,
    captureViewport,
    onError
  })
  const args = {
    browserPageId: 'owned-page',
    workspaceId: 'workspace',
    worktreeId: 'folder',
    sessionProfileId: null,
    url: 'https://example.test/'
  }
  return {
    service,
    sender,
    senderShape,
    guest,
    native,
    owner,
    container,
    host,
    manager,
    registered,
    events,
    onError,
    retirePage,
    captureViewport,
    onRegistered,
    args,
    order,
    properties
  }
}
