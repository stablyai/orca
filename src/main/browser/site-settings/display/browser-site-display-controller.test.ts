import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import { browserPageZoomLevelToPercent } from '../../../../shared/browser-page-zoom'
import { BrowserSiteDisplayController } from './browser-site-display-controller'
import {
  configureBrowserSiteDisplayStore,
  updateBrowserSiteDisplay
} from './browser-site-display-store'

type FakeGuest = Electron.WebContents &
  EventEmitter & { url: string; level: number; mediaSent: unknown[] }

let nextGuestId = 1

function fakeGuest(url: string): FakeGuest {
  const debuggerEvents = new EventEmitter()
  let attached = false
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller only reads id, getURL, zoom, isDestroyed, dom-ready and the debugger.
  const guest = new EventEmitter() as FakeGuest
  Object.assign(guest, {
    id: nextGuestId++,
    url,
    level: 0,
    mediaSent: [],
    isDestroyed: () => false,
    getURL: () => guest.url,
    getZoomLevel: () => guest.level,
    setZoomLevel: (level: number) => {
      guest.level = level
    },
    debugger: Object.assign(debuggerEvents, {
      isAttached: () => attached,
      attach: () => {
        attached = true
      },
      detach: () => {
        attached = false
        debuggerEvents.emit('detach')
      },
      sendCommand: (method: string, params: { features: { value: string }[] }) => {
        if (method === 'Emulation.setEmulatedMedia') {
          guest.mediaSent.push(params.features[0].value)
        }
        return Promise.resolve({})
      }
    })
  })
  return guest
}

function uiStore(initial: Partial<PersistedUIState> = {}): {
  getUI: () => PersistedUIState
  onUIChanged: (listener: (ui: PersistedUIState) => void) => () => void
  update: (update: Partial<PersistedUIState>) => void
} {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller reads only uiZoomLevel and browserDefaultZoomLevel.
  let ui = { uiZoomLevel: 0, browserDefaultZoomLevel: 0, ...initial } as PersistedUIState
  const listeners: ((ui: PersistedUIState) => void)[] = []
  return {
    getUI: () => ui,
    onUIChanged: (listener) => {
      listeners.push(listener)
      return () => {}
    },
    update: (update) => {
      ui = { ...ui, ...update }
      listeners.forEach((listener) => listener(ui))
    }
  }
}

const percent = (guest: FakeGuest): number => browserPageZoomLevelToPercent(guest.level)

beforeEach(() => {
  configureBrowserSiteDisplayStore(mkdtempSync(join(tmpdir(), 'orca-site-display-')))
})

describe('BrowserSiteDisplayController zoom', () => {
  it("restores the site's zoom after Orca's UI zoom is copied onto the page", () => {
    const controller = new BrowserSiteDisplayController()
    const ui = uiStore()
    controller.followZoomSettings(ui)
    const guest = fakeGuest('https://github.com/')
    controller.onGuestRegistered(guest, null)
    controller.zoomPage(guest.id, 'in')
    // Model Electron copying the embedder's zoom on UI changes and navigation.
    const copyUIZoom = (): void => {
      guest.level = 1
    }

    copyUIZoom()
    ui.update({ uiZoomLevel: 1 })
    expect(percent(guest)).toBe(110)

    guest.url = 'https://github.com/next'
    controller.onMainFrameNavigationCommitted(guest.id)
    copyUIZoom()
    guest.emit('dom-ready')
    expect(percent(guest)).toBe(110)

    copyUIZoom()
    controller.zoomPage(guest.id, 'in')
    expect(percent(guest)).toBe(125)
  })
})

describe('BrowserSiteDisplayController color scheme', () => {
  it.each([
    { order: 'read-first', profileId: 'work', colorScheme: 'light', saved: 'dark' },
    { order: 'registration-first', profileId: 'work', colorScheme: 'light', saved: 'dark' }
  ] as const)(
    'keeps actual $profileId precedence across $order, reload and debugger loss',
    ({ order, profileId, colorScheme, saved }) => {
      const controller = new BrowserSiteDisplayController()
      updateBrowserSiteDisplay('default', 'file://', { colorScheme: 'light' })
      updateBrowserSiteDisplay('work', 'file://', { colorScheme: 'dark' })
      const guest = fakeGuest('')
      const document = {
        url: 'file:///chat-scratch/chart.html',
        profileId,
        colorScheme
      }
      const rendererProfile = profileId === 'work' ? 'default' : 'work'
      if (order === 'registration-first') {
        controller.onGuestRegistered(guest, rendererProfile)
      }
      controller.onGuestDocumentStart(guest, document)
      expect(guest.mediaSent.at(-1)).toBe(saved)
      controller.onGuestRegistered(guest, rendererProfile)
      expect(guest.mediaSent.at(-1)).toBe(saved)
      guest.url = document.url
      controller.onGuestRegistered(guest, rendererProfile)
      expect(controller.getPageDisplay(guest.id)?.colorScheme).toBe(saved)
      expect(guest.listenerCount('dom-ready')).toBe(1)
      expect(guest.debugger.listenerCount('detach')).toBe(1)
      guest.debugger.detach()
      expect(guest.debugger.isAttached()).toBe(false)
      const before = guest.mediaSent.length
      controller.onGuestDocumentStart(guest, document)
      expect(guest.mediaSent.slice(before)).toEqual([saved])
      expect(guest.debugger.isAttached()).toBe(true)
      controller.setColorScheme(guest.id, null)
      expect(guest.mediaSent.at(-1)).toBe(colorScheme)
      const replacement = fakeGuest('')
      controller.onGuestDocumentStart(replacement, document)
      expect(replacement.mediaSent).toEqual([colorScheme])
      controller.onGuestRetired(guest.id)
      controller.onGuestRetired(replacement.id)
      expect(guest.listenerCount('dom-ready')).toBe(0)
      expect(guest.debugger.listenerCount('detach')).toBe(0)
    }
  )
})

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
