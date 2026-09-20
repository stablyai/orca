// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

/**
 * A start sequence that throws leaves nothing of itself behind.
 *
 * The starts are not all writes to the scope: `startHostNotify` installs the host's error
 * reporter and `startTapDispatch` takes four document listeners. If one of the later starts
 * throws, the mount fails and its handle releases the page — but the reporter and the listeners
 * are already installed, and nothing else would reach them: the next mount's reset nulls the undo
 * the install handed back, so the listener would stay for the life of the tab.
 *
 * The provocation is the document's own markup with the selection menu missing, which is what
 * `startSelectionMenuButtons` reads and the only thing it does.
 */
const MARKUP_WITHOUT_THE_MENU =
  '<div id="terminal-container"><div id="terminal-surface"></div></div>' +
  '<div id="selection-overlay"><div id="sel-handle-start"></div>' +
  '<div id="sel-handle-end"></div></div>' +
  '<div id="scroll-indicator"><div id="scroll-thumb"></div></div>'

describe('the page start sequence', () => {
  it('unwinds the starts that completed when a later one throws', async () => {
    document.body.innerHTML = MARKUP_WITHOUT_THE_MENU
    const { startPageDocumentModules } = await import('./page-document-modules')
    const previous = window.onerror
    window.onerror = null
    try {
      expect(() => startPageDocumentModules()).toThrow()
      // `startHostNotify` ran and installed the default reporter, which takes `window.onerror`.
      // The unwind is the only thing that gives it back: the next mount's reset nulls the undo it
      // handed out, so an install left standing here is permanent.
      expect(window.onerror).toBe(null)
    } finally {
      window.onerror = previous
    }
  })

  it('would have installed one, so the null above is a measurement', async () => {
    // The precondition. With the menu present the same sequence completes, and the reporter it
    // installs is exactly what the case above asserts was taken back.
    document.body.innerHTML = MARKUP_WITHOUT_THE_MENU.replace(
      '<div id="sel-handle-end"></div></div>',
      '<div id="sel-handle-end"></div><div id="sel-menu">' +
        '<button id="sel-menu-copy"></button><button id="sel-menu-all"></button></div></div>'
    )
    const { startPageDocumentModules, stopPageDocumentModules } =
      await import('./page-document-modules')
    const previous = window.onerror
    window.onerror = null
    try {
      startPageDocumentModules()
      expect(window.onerror).not.toBe(null)
      stopPageDocumentModules()
      expect(window.onerror).toBe(null)
    } finally {
      window.onerror = previous
    }
  })
})
