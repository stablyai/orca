import { describe, expect, it } from 'vitest'
import { mapGhosttyToOrca } from './mapper'

describe('mapGhosttyToOrca — split-divider-color', () => {
  it('maps valid hex to both dark and light divider colors', () => {
    const result = mapGhosttyToOrca({ 'split-divider-color': '#ff5500' })
    expect(result.diff).toEqual({
      terminalDividerColorDark: '#ff5500',
      terminalDividerColorLight: '#ff5500'
    })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps hex without hash to both divider colors', () => {
    const result = mapGhosttyToOrca({ 'split-divider-color': 'ff5500' })
    expect(result.diff).toEqual({
      terminalDividerColorDark: '#ff5500',
      terminalDividerColorLight: '#ff5500'
    })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid split-divider-color', () => {
    const result = mapGhosttyToOrca({ 'split-divider-color': 'blue' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['split-divider-color'])
  })
})

describe('mapGhosttyToOrca — unfocused-split-opacity', () => {
  it('maps valid float to terminalInactivePaneOpacity', () => {
    const result = mapGhosttyToOrca({ 'unfocused-split-opacity': '0.5' })
    expect(result.diff).toEqual({ terminalInactivePaneOpacity: 0.5 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects out-of-range unfocused-split-opacity', () => {
    const result = mapGhosttyToOrca({ 'unfocused-split-opacity': '1.2' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['unfocused-split-opacity'])
  })

  it('rejects negative unfocused-split-opacity', () => {
    const result = mapGhosttyToOrca({ 'unfocused-split-opacity': '-0.1' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['unfocused-split-opacity'])
  })
})

describe('mapGhosttyToOrca — scrollback-limit', () => {
  // Why: Ghostty's scrollback-limit is a byte budget (where 0 means unlimited),
  // while xterm's scrollback is a row count (where 0 means disabled). The
  // units and sentinel values don't line up, so we treat the key as
  // unsupported rather than silently mis-applying it by orders of magnitude.
  it('marks scrollback-limit as unsupported', () => {
    const result = mapGhosttyToOrca({ 'scrollback-limit': '50000' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['scrollback-limit'])
  })
})

describe('mapGhosttyToOrca — window-padding', () => {
  it('maps window-padding-x to terminalPaddingX', () => {
    const result = mapGhosttyToOrca({ 'window-padding-x': '8' })
    expect(result.diff).toEqual({ terminalPaddingX: 8 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps window-padding-y to terminalPaddingY', () => {
    const result = mapGhosttyToOrca({ 'window-padding-y': '4' })
    expect(result.diff).toEqual({ terminalPaddingY: 4 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid window-padding-x', () => {
    const result = mapGhosttyToOrca({ 'window-padding-x': 'wide' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['window-padding-x'])
  })
})

describe('mapGhosttyToOrca — cursor-text', () => {
  it('maps valid hex to terminalColorOverrides.cursorAccent', () => {
    const result = mapGhosttyToOrca({ 'cursor-text': '#ffffff' })
    expect(result.diff).toEqual({
      terminalColorOverrides: { cursorAccent: '#ffffff' }
    })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid cursor-text', () => {
    const result = mapGhosttyToOrca({ 'cursor-text': 'white' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['cursor-text'])
  })
})

describe('mapGhosttyToOrca — bold-color', () => {
  it('maps valid hex to terminalColorOverrides.bold', () => {
    const result = mapGhosttyToOrca({ 'bold-color': '#ff0000' })
    expect(result.diff).toEqual({
      terminalColorOverrides: { bold: '#ff0000' }
    })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid bold-color', () => {
    const result = mapGhosttyToOrca({ 'bold-color': 'red' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['bold-color'])
  })
})

describe('mapGhosttyToOrca — mouse-hide-while-typing', () => {
  it('maps true to terminalMouseHideWhileTyping', () => {
    const result = mapGhosttyToOrca({ 'mouse-hide-while-typing': 'true' })
    expect(result.diff).toEqual({ terminalMouseHideWhileTyping: true })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps false to terminalMouseHideWhileTyping', () => {
    const result = mapGhosttyToOrca({ 'mouse-hide-while-typing': 'false' })
    expect(result.diff).toEqual({ terminalMouseHideWhileTyping: false })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid mouse-hide-while-typing', () => {
    const result = mapGhosttyToOrca({ 'mouse-hide-while-typing': 'yes' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['mouse-hide-while-typing'])
  })
})

describe('mapGhosttyToOrca — selection-word-chars', () => {
  it('treats selection-word-chars as unsupported due to semantic inversion', () => {
    const result = mapGhosttyToOrca({ 'selection-word-chars': ':/?#@' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['selection-word-chars'])
  })
})

describe('mapGhosttyToOrca — cursor-opacity', () => {
  it('maps valid float to terminalCursorOpacity', () => {
    const result = mapGhosttyToOrca({ 'cursor-opacity': '0.75' })
    expect(result.diff).toEqual({ terminalCursorOpacity: 0.75 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects out-of-range cursor-opacity', () => {
    const result = mapGhosttyToOrca({ 'cursor-opacity': '1.5' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['cursor-opacity'])
  })

  it('rejects negative cursor-opacity', () => {
    const result = mapGhosttyToOrca({ 'cursor-opacity': '-0.1' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['cursor-opacity'])
  })
})

describe('mapGhosttyToOrca — empty values', () => {
  it('rejects empty background-opacity', () => {
    const result = mapGhosttyToOrca({ 'background-opacity': '' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['background-opacity'])
  })

  it('rejects empty cursor-opacity', () => {
    const result = mapGhosttyToOrca({ 'cursor-opacity': '' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['cursor-opacity'])
  })

  it('rejects empty unfocused-split-opacity', () => {
    const result = mapGhosttyToOrca({ 'unfocused-split-opacity': '' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['unfocused-split-opacity'])
  })
})

describe('mapGhosttyToOrca — negative padding', () => {
  it('rejects negative window-padding-x', () => {
    const result = mapGhosttyToOrca({ 'window-padding-x': '-4' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['window-padding-x'])
  })

  it('rejects negative window-padding-y', () => {
    const result = mapGhosttyToOrca({ 'window-padding-y': '-2' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['window-padding-y'])
  })
})
