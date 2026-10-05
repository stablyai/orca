import { describe, expect, it } from 'vitest'
import type { DesktopBrowserViewEvent } from '../../shared/desktop-browser-view-protocol'
import { BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX } from '../../shared/browser-annotation-viewport-bridge'
import { observeDesktopBrowserView } from './desktop-browser-view-state'
import { createOwnedViewFixture } from './desktop-owned-browser-view-test-fixture'

function prepareGuest(
  f: ReturnType<typeof createOwnedViewFixture>,
  url = 'https://first.test/page'
) {
  let currentUrl = url
  Object.assign(f.guest, {
    getURL: () => currentUrl,
    getTitle: () => 'Fixture page',
    isLoading: () => false,
    getZoomLevel: () => 0,
    isFocused: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false }
  })
  return {
    guest: f.guest,
    setUrl: (next: string): void => {
      currentUrl = next
    }
  }
}

describe('desktop owned browser view state', () => {
  it('clears a prior favicon before the document navigation event and selects a usable replacement', () => {
    const f = createOwnedViewFixture()
    const { guest, setUrl } = prepareGuest(f)
    const events: DesktopBrowserViewEvent[] = []
    const observer = observeDesktopBrowserView(
      f.record,
      (event) => events.push(event),
      () => {}
    )
    guest.emit('page-favicon-updated', {}, ['data:,', 'https://first.test/icon.png'])
    events.length = 0
    guest.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'https://second.test/'
    })
    setUrl('https://second.test/')
    guest.emit('did-navigate', {}, 'https://second.test/')
    expect(events[0]).toMatchObject({ kind: 'state', state: { faviconUrl: null } })
    // The state observer precedes the document observer, so committed navigation follows state snapshots.
    expect(events.at(-1)).toMatchObject({ kind: 'navigation-commit', url: 'https://second.test/' })
    expect(events.at(-2)).toMatchObject({ kind: 'state', state: { url: 'https://second.test/' } })
    guest.emit('page-favicon-updated', {}, [
      'data:,',
      'file:///not-usable',
      'https://second.test/icon.png'
    ])
    expect(events.at(-1)).toMatchObject({
      kind: 'state',
      state: { faviconUrl: 'https://second.test/icon.png' }
    })
    observer.dispose()
  })

  it('publishes token-scoped document geometry only after state listeners are registered', () => {
    const f = createOwnedViewFixture()
    const { guest } = prepareGuest(f)
    const events: DesktopBrowserViewEvent[] = []
    const observer = observeDesktopBrowserView(
      f.record,
      (event) => events.push(event),
      () => {}
    )
    const token = 'abcdef1234567890'
    guest.emit('did-start-loading')
    guest.emit('console-message', {
      message: `${BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX}${token}:{"scrollX":3,"scrollY":81}`
    })
    expect(events.map((event) => event.kind)).toEqual(['state', 'annotation-viewport'])
    expect(events[1]).toMatchObject({
      browserPageId: f.record.browserPageId,
      generation: f.record.generation,
      token,
      scrollX: 3,
      scrollY: 81
    })
    observer.dispose()
    expect(guest.listenerCount('console-message')).toBe(0)
  })
})
