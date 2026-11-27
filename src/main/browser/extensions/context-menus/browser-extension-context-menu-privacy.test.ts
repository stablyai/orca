import { beforeEach, expect, it, vi } from 'vitest'
import type { StoredContextMenuItem } from '../profile-storage/browser-extension-profile-state-store'
import { startBrowserExtensionDocument } from '../tabs-and-windows/browser-extension-document-ids'

const state = vi.hoisted(() => ({
  items: new Array<StoredContextMenuItem>(),
  emit: vi.fn(),
  allowed: true,
  guests: new Map<number, Electron.WebContents>(),
  frames: new Map<string, Electron.WebFrameMain>(),
  owners: new Map<Electron.WebFrameMain, Electron.WebContents>()
}))
vi.mock('electron', () => ({
  webContents: {
    fromId: (id: number) => state.guests.get(id),
    fromFrame: (frame: Electron.WebFrameMain) => state.owners.get(frame)
  },
  webFrameMain: {
    fromId: (process: number, routing: number) => state.frames.get(`${process}:${routing}`)
  }
}))
vi.mock('../browser-extension-support', () => ({ isBrowserExtensionSupportEnabled: () => true }))
vi.mock('../tabs-and-windows/browser-extension-frame-projection', () => ({
  chromeFrameId: () => 7
}))
vi.mock('../permissions/browser-extension-user-gesture', () => ({
  noteBrowserExtensionUserGesture: vi.fn()
}))
vi.mock('../permissions/browser-extension-active-tab', () => ({
  grantBrowserExtensionActiveTab: vi.fn()
}))
vi.mock('../api-runtime/browser-extension-api-host', () => ({
  emitBrowserExtensionEvent: state.emit,
  getBrowserExtensionProfileIdForSession: () => 'default'
}))
vi.mock('../installation/browser-extension-install-store', () => ({
  getBrowserExtensionInstallStore: () => ({ get: () => null })
}))
vi.mock('../api-runtime/browser-extension-namespace-registry', () => ({
  extensionHasPermission: () => state.allowed
}))
vi.mock('../profile-storage/browser-extension-profile-state-store', () => ({
  getBrowserExtensionProfileStateStore: () => ({ read: () => ({ contextMenus: state.items }) })
}))
vi.mock('../tabs-and-windows/browser-extension-tab-model', () => ({
  resolveBrowserExtensionTab: (id: number) => {
    const contents = state.guests.get(id)
    return contents ? { contents } : null
  },
  describeBrowserExtensionTab: () => ({ id: 100 })
}))
import { createContextMenuItem } from './browser-extension-context-menu-model'
import {
  buildBrowserExtensionPageContextMenu,
  runBrowserExtensionContextMenuClick
} from './browser-extension-context-menu-host'
import { contextMenuTargetFromParams } from './browser-extension-context-menu-target'

beforeEach(() => {
  state.emit.mockClear()
  state.allowed = true
  state.guests.clear()
  state.frames.clear()
  state.owners.clear()
})

function page(frameUrl: string) {
  const extension = { id: 'extension', name: 'Extension' }
  const session = {
    extensions: { getAllExtensions: () => [extension], getExtension: () => extension }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native adapter fixture supplies only the frame identity and lifecycle APIs the menu reads.
  const mainFrame = {
    processId: 1,
    routingId: 1,
    parent: null,
    isDestroyed: () => false
  } as Electron.WebFrameMain
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same native frame adapter with a subframe URL.
  const frame = {
    processId: 1,
    routingId: 2,
    parent: mainFrame,
    url: frameUrl,
    isDestroyed: () => false
  } as Electron.WebFrameMain
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native guest adapter used only through these APIs.
  const guest = {
    id: 100,
    session,
    mainFrame,
    getURL: () => 'https://kagi.com/top?token=top-secret&q=one',
    isDestroyed: () => false
  } as unknown as Electron.WebContents
  state.guests.set(100, guest)
  state.frames.set('1:2', frame)
  state.owners.set(frame, guest)
  state.items = createContextMenuItem([], {
    id: 'inspect',
    title: 'Inspect',
    contexts: ['frame'],
    documentUrlPatterns: [frameUrl]
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native context-menu event adapter supplies the fields this page menu consumes.
  const params = { frame, frameURL: frameUrl, isEditable: false } as Electron.ContextMenuParams
  const menu = buildBrowserExtensionPageContextMenu(guest, params)
  return {
    frame,
    guest,
    menu,
    click: () =>
      runBrowserExtensionContextMenuClick({
        token: menu?.token ?? '',
        extensionId: 'extension',
        key: '"inspect"'
      })
  }
}

it.each([
  ['https://kagi.com/search?token=frame-secret&q=one', 'https://kagi.com/search?q=one'],
  ['https://example.com/frame?token=ordinary', 'https://example.com/frame?token=ordinary']
])('checks the real document pattern but publishes safe frame metadata: %s', (raw, safe) => {
  expect(
    contextMenuTargetFromParams(
      { frameURL: raw },
      'https://kagi.com/top?token=top-secret&q=one',
      true
    )
  ).toMatchObject({
    pageUrl: 'https://kagi.com/top?q=one',
    frameUrl: safe
  })
  const context = page(raw)
  expect(context.menu?.groups[0]?.items[0]?.key).toBe('"inspect"')
  expect(context.click()).toBe(true)
  expect(state.emit).toHaveBeenCalledWith(expect.anything(), 'contextMenus', 'onClicked', [
    expect.objectContaining({ pageUrl: 'https://kagi.com/top?q=one', frameUrl: safe }),
    { id: 100 }
  ])
})

it('rejects a menu after its subframe changes documents', () => {
  const context = page('https://kagi.com/search?token=frame-secret&q=one')
  startBrowserExtensionDocument(context.frame)
  expect(context.click()).toBe(false)
  expect(state.emit).not.toHaveBeenCalled()
})

it('rejects a frame belonging to another guest', () => {
  const context = page('https://kagi.com/search?token=frame-secret&q=one')
  state.owners.delete(context.frame)
  expect(context.click()).toBe(false)
  expect(state.emit).not.toHaveBeenCalled()
})

it('rechecks extension permission before publishing a click', () => {
  const context = page('https://kagi.com/search?token=frame-secret&q=one')
  state.allowed = false
  expect(context.click()).toBe(false)
  expect(state.emit).not.toHaveBeenCalled()
})
