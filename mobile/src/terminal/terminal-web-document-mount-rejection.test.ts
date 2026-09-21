// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

/**
 * What a mount whose chunk never arrived is allowed to touch on its way out.
 *
 * The one path where a mount reaches its own cleanup holding a page that belongs to someone else.
 * Everywhere else the build reads the claim again after its import and stops, but a rejected
 * import never gets that far: the failure arrives at the mount's error handler directly, and by
 * then the overlay's Reload may already have built a second document into the same element. A
 * release that emptied the host anyway would blank the terminal on the screen and hand the page
 * back while its document ran on.
 *
 * Its own file because making the import fail is the only way to reach this, and the mock has to
 * be in place before the mount module is loaded. It fails once, so the second mount gets the real
 * modules and can be a live document to protect.
 */

const { chunk } = vi.hoisted(() => ({ chunk: { failures: 0 } }))
vi.mock('./document/page-document-modules', async (importOriginal) => {
  if (chunk.failures === 0) {
    chunk.failures += 1
    throw new Error('orca-document-chunk-failed')
  }
  return importOriginal()
})

const { mountTerminalWebDocument } = await import('./terminal-web-document-mount')

const HOST_CLASS = 'orca-terminal-document-host'

describe('a page mount whose document chunk failed', () => {
  it('leaves the document that replaced it alone', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    let resizeListeners = 0
    const realAdd = window.addEventListener.bind(window)
    const realRemove = window.removeEventListener.bind(window)
    // Parameters taken from the bound original, so the wrapper carries the real signature rather
    // than three implicit `any`s the tests typecheck refuses.
    window.addEventListener = (...added: Parameters<typeof realAdd>) => {
      resizeListeners += added[0] === 'resize' ? 1 : 0
      realAdd(...added)
    }
    window.removeEventListener = (...removed: Parameters<typeof realRemove>) => {
      resizeListeners -= removed[0] === 'resize' ? 1 : 0
      realRemove(...removed)
    }

    // Put back whatever happens, as the sibling case does: a failure part way through would
    // otherwise leave the patched functions on `window` for everything that runs after it.
    try {
      const abandoned = mountTerminalWebDocument(host, () => {})
      abandoned.dispose()
      // The same element, as React hands it back on the overlay's Reload.
      const live = mountTerminalWebDocument(host, () => {})
      // The message is the mocking layer's, not the one thrown, so the two counters are what say
      // which import did what: the abandoned mount's failed, and the live mount's did not.
      await expect(abandoned.ready).rejects.toThrow()
      expect(chunk.failures, 'the abandoned mount is the one whose chunk failed').toBe(1)

      expect(host.querySelector('#terminal-container')).not.toBe(null)
      expect(host.classList.contains(HOST_CLASS)).toBe(true)
      // Still claimed, so the release did not hand the page back either.
      expect(() => mountTerminalWebDocument(host, () => {})).toThrow(
        'the terminal document is already mounted on this page'
      )

      await live.ready
      // The other half of the precondition: the mount that replaced it is a real started document,
      // not a second casualty. Its resize listener is the one the start sequence adds.
      expect(resizeListeners, 'the live mount started its document').toBe(1)
      // And disposing the abandoned handle a second time changes nothing.
      abandoned.dispose()
      expect(host.querySelector('#terminal-container')).not.toBe(null)
      expect(host.classList.contains(HOST_CLASS)).toBe(true)
      live.dispose()
      expect(host.querySelector('#terminal-container')).toBe(null)
      expect(resizeListeners, 'and it took its listener back on the way out').toBe(0)
    } finally {
      window.addEventListener = realAdd
      window.removeEventListener = realRemove
    }
  })
})
