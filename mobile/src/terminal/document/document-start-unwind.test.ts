// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createTerminalDocument } from './create-terminal-document'

// Drive the generated factory with missing menu markup so a late startup throw must undo reporters, listeners and transport before returning no handle.
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
      // No handle returned, so only factory unwind can restore window.onerror after the partial start.
      expect(window.onerror).toBe(null)
    } finally {
      window.onerror = previous
    }
  })

  it('would have installed one, so the null above is a measurement', () => {
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
