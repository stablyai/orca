import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { watchBrowserGuestDocument } from './watch-browser-guest-document'
import type { BrowserGuestDocumentEvent } from '../../../shared/browser/annotations/browser-guest-document-event'

describe('watchBrowserGuestDocument', () => {
  it('reports the current document and resets the picker when main-frame navigation starts', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This stream uses only the event emitter and the three stubbed guest methods.
    const guest = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      getURL: () => 'https://example.com/initial'
    }) as EventEmitter & Electron.WebContents
    const events: BrowserGuestDocumentEvent[] = []
    const controller = new AbortController()
    const watch = watchBrowserGuestDocument(guest, (event) => events.push(event), controller.signal)

    guest.emit('did-start-navigation', { isSameDocument: false, isMainFrame: false })
    guest.emit('did-start-navigation', { isSameDocument: true, isMainFrame: true })
    guest.emit('did-start-navigation', { isSameDocument: false, isMainFrame: true })

    expect(events).toEqual([
      { type: 'navigated', url: 'https://example.com/initial' },
      { type: 'domReady' },
      { type: 'documentStart' }
    ])
    controller.abort()
    await watch
  })
})
