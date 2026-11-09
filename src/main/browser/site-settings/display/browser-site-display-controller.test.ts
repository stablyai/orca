import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import {
  browserPageZoomLevelToPercent,
  normalizeBrowserPageZoomLevel
} from '../../../../shared/browser-page-zoom'
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

function commit(controller: BrowserSiteDisplayController, guest: FakeGuest, url: string): void {
  guest.url = url
  controller.onMainFrameNavigationCommitted(guest.id)
  guest.emit('dom-ready')
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
  it('keeps zoom per site and browser profile, and resets it to Default Zoom', () => {
    const controller = new BrowserSiteDisplayController()
    const ui = uiStore({ browserDefaultZoomLevel: normalizeBrowserPageZoomLevel(0.5) })
    controller.followZoomSettings(ui)
    const github = fakeGuest('https://github.com/a')
    const githubOtherPort = fakeGuest('https://github.com:8443/b')
    const githubWork = fakeGuest('https://github.com/c')
    const docs = fakeGuest('https://docs.example.com/')
    controller.onGuestRegistered(github, null)
    controller.onGuestRegistered(githubOtherPort, 'default')
    controller.onGuestRegistered(githubWork, 'work')
    controller.onGuestRegistered(docs, null)

    controller.zoomPage(github.id, 'in')

    expect([github, githubOtherPort, githubWork, docs].map(percent)).toEqual([125, 125, 110, 110])
    commit(controller, docs, 'https://github.com/d')
    expect(percent(docs)).toBe(125)

    expect(controller.zoomPage(github.id, 'reset')).toMatchObject({ siteHasZoom: false })
    expect([github, githubOtherPort, docs].map(percent)).toEqual([110, 110, 110])
  })

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
  it('uses chat media for document guests without changing zoom, and upgrades browser registration', () => {
    const controller = new BrowserSiteDisplayController()
    const preview = fakeGuest('orca-preview://grant/theme.html')
    preview.level = 1
    controller.onGuestDocumentStart(preview, {
      url: preview.url,
      profileId: null,
      colorScheme: 'dark'
    })
    controller.onMainFrameNavigationCommitted(preview.id)
    expect(preview.mediaSent).toEqual(['dark', 'dark'])
    expect(preview.level).toBe(1)
    expect(preview.listenerCount('dom-ready')).toBe(0)

    const local = fakeGuest('file:///chat-scratch/theme.html')
    controller.onGuestDocumentStart(local, {
      url: local.url,
      profileId: 'work',
      colorScheme: 'dark'
    })
    controller.onGuestRegistered(local, 'work')
    controller.setColorScheme(local.id, 'light')
    controller.setGuestColorSchemeFallback(local, 'light')
    controller.setGuestColorSchemeFallback(local, 'dark')
    expect(local.mediaSent.at(-1)).toBe('light')
    expect(controller.getPageDisplay(local.id)?.colorScheme).toBe('light')
    controller.setColorScheme(local.id, null)
    expect(local.mediaSent.at(-1)).toBe('dark')
    controller.setGuestColorSchemeFallback(local, undefined)
    commit(controller, local, 'https://ordinary.example/')
    expect(local.mediaSent.slice(-2)).toEqual(['dark', ''])
    controller.onGuestRetired(preview.id)
    expect(preview.debugger.isAttached()).toBe(false)
  })

  it.each([
    { order: 'read-first', profileId: 'work', colorScheme: 'light', saved: 'dark' },
    { order: 'registration-first', profileId: 'work', colorScheme: 'light', saved: 'dark' },
    { order: 'read-first', profileId: 'default', colorScheme: 'dark', saved: 'light' },
    { order: 'registration-first', profileId: 'default', colorScheme: 'dark', saved: 'light' }
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
