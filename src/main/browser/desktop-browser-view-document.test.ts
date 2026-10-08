import { describe, expect, it } from 'vitest'
import { BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX } from '../../shared/browser-annotation-viewport-bridge'
import type { DesktopBrowserViewEvent } from '../../shared/desktop-browser-view-protocol'
import { createOwnedViewFixture } from './desktop-owned-browser-view-test-fixture'
import { observeDesktopBrowserViewDocument } from './desktop-browser-view-document'

describe('owned browser document event bridge', () => {
  it('forwards main document navigation, readiness and crashes with their exact generation', () => {
    const f = createOwnedViewFixture()
    const events: DesktopBrowserViewEvent[] = []
    const dispose = observeDesktopBrowserViewDocument(f.record, (event) => events.push(event))
    f.guest.emit('did-start-navigation', {
      isMainFrame: false,
      isSameDocument: false,
      url: 'https://frame.test'
    })
    expect(events).toEqual([])
    f.guest.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'https://example.test'
    })
    f.guest.emit('did-navigate', {}, 'https://example.test')
    f.guest.emit('dom-ready')
    f.guest.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(events.map((event) => event.kind)).toEqual([
      'navigation-start',
      'navigation-commit',
      'page-ready',
      'renderer-gone'
    ])
    expect(
      events.every((event) => event.kind !== 'state' && event.generation === f.record.generation)
    ).toBe(true)
    dispose()
    expect(f.guest.listenerCount('console-message')).toBe(0)
    expect(f.guest.listenerCount('dom-ready')).toBe(0)
  })

  it('forwards only bounded token-scoped finite annotation geometry, never arbitrary console text', () => {
    const f = createOwnedViewFixture()
    const events: DesktopBrowserViewEvent[] = []
    const dispose = observeDesktopBrowserViewDocument(f.record, (event) => events.push(event))
    const token = 'abcdef1234567890'
    const prefix = `${BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX}${token}:`
    for (const message of [
      'private page log',
      `${prefix}{bad`,
      `${prefix}{"scrollX":null,"scrollY":1}`,
      `${prefix}${' '.repeat(1025)}`
    ]) {
      f.guest.emit('console-message', { message })
    }
    expect(events).toEqual([])
    f.guest.emit('console-message', { message: `${prefix}{"scrollX":3,"scrollY":81}` })
    expect(events).toEqual([
      {
        browserPageId: f.record.browserPageId,
        generation: f.record.generation,
        kind: 'annotation-viewport',
        token,
        scrollX: 3,
        scrollY: 81
      }
    ])
    dispose()
  })
})
