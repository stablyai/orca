// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createTerminalDocument } from './create-terminal-document'

/**
 * A start sequence that throws leaves nothing of itself behind.
 *
 * The starts are not all writes to the scope: `startHostNotify` installs the host's error reporter,
 * `startTapDispatch` takes four document listeners and `startMessageBridge` installs the host's
 * transport. If one of the later starts throws there is no handle, so nothing else could reach
 * them, and the reporter and the listeners would stay for the life of the page.
 *
 * Ruling 24 made the unwind the document's own: the factory calls its `stop` and rethrows, so both
 * hosts get it rather than whichever one remembered to write it. Asserted against the generated
 * factory because that is the text both hosts run.
 *
 * The provocation is the document's own markup with the selection menu missing, which is what
 * `startSelectionMenuButtons` reads and the only thing it does.
 */
const MARKUP_WITHOUT_THE_MENU =
  '<div id="terminal-container"><div id="terminal-surface"></div></div>' +
  '<div id="selection-overlay"><div id="sel-handle-start"></div>' +
  '<div id="sel-handle-end"></div></div>' +
  '<div id="scroll-indicator"><div id="scroll-thumb"></div></div>'

const MARKUP_WITH_THE_MENU = MARKUP_WITHOUT_THE_MENU.replace(
  '<div id="sel-handle-end"></div></div>',
  '<div id="sel-handle-end"></div><div id="sel-menu">' +
    '<button id="sel-menu-copy"></button><button id="sel-menu-all"></button></div></div>'
)

/** The engine the document would build, reduced to what the start sequence itself touches. */
const hostWithoutAnEngine = () => ({
  postToHost: () => {},
  hasEngine: () => false
})

describe('the document start sequence', () => {
  it('unwinds the starts that completed when a later one throws', () => {
    document.body.innerHTML = MARKUP_WITHOUT_THE_MENU
    const previous = window.onerror
    window.onerror = null
    try {
      expect(() => createTerminalDocument(hostWithoutAnEngine())).toThrow()
      // `startHostNotify` ran and installed the default reporter, which takes `window.onerror`.
      // The unwind is the only thing that gives it back: the handle that would have carried `stop`
      // was never returned, so an install left standing here is permanent.
      expect(window.onerror).toBe(null)
    } finally {
      window.onerror = previous
    }
  })

  it('would have installed one, so the null above is a measurement', () => {
    // The precondition. With the menu present the same sequence completes, and the reporter it
    // installs is exactly what the case above asserts was taken back.
    document.body.innerHTML = MARKUP_WITH_THE_MENU
    const previous = window.onerror
    window.onerror = null
    try {
      const started = createTerminalDocument(hostWithoutAnEngine())
      expect(window.onerror).not.toBe(null)
      started.stop()
      expect(window.onerror).toBe(null)
    } finally {
      window.onerror = previous
    }
  })
})
