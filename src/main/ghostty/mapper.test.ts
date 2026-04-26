import { describe, expect, it } from 'vitest'
import { mapGhosttyToOrca } from './mapper'

describe('mapGhosttyToOrca — font & cursor', () => {
  it('maps supported keys to GlobalSettings', () => {
    const result = mapGhosttyToOrca({
      'font-family': 'JetBrains Mono',
      'font-size': '14',
      'cursor-style': 'bar'
    })
    expect(result.diff).toEqual({
      terminalFontFamily: 'JetBrains Mono',
      terminalFontSize: 14,
      terminalCursorStyle: 'bar'
    })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('skips invalid font-size values', () => {
    const result = mapGhosttyToOrca({ 'font-size': 'not-a-number' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['font-size'])
  })

  it('skips invalid cursor-style values', () => {
    const result = mapGhosttyToOrca({ 'cursor-style': 'beam' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['cursor-style'])
  })

  it('returns zero font-size as unsupported', () => {
    const result = mapGhosttyToOrca({ 'font-size': '0' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['font-size'])
  })

  it('maps font-weight to terminalFontWeight', () => {
    const result = mapGhosttyToOrca({ 'font-weight': '700' })
    expect(result.diff).toEqual({ terminalFontWeight: 700 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects out-of-range font-weight', () => {
    const result = mapGhosttyToOrca({ 'font-weight': '50' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['font-weight'])
  })

  it('maps cursor-style-blink true to terminalCursorBlink', () => {
    const result = mapGhosttyToOrca({ 'cursor-style-blink': 'true' })
    expect(result.diff).toEqual({ terminalCursorBlink: true })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps cursor-style-blink false to terminalCursorBlink', () => {
    const result = mapGhosttyToOrca({ 'cursor-style-blink': 'false' })
    expect(result.diff).toEqual({ terminalCursorBlink: false })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid cursor-style-blink value', () => {
    const result = mapGhosttyToOrca({ 'cursor-style-blink': 'yes' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['cursor-style-blink'])
  })

  it('maps focus-follows-mouse to terminalFocusFollowsMouse', () => {
    const result = mapGhosttyToOrca({ 'focus-follows-mouse': 'true' })
    expect(result.diff).toEqual({ terminalFocusFollowsMouse: true })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid focus-follows-mouse value', () => {
    const result = mapGhosttyToOrca({ 'focus-follows-mouse': '1' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['focus-follows-mouse'])
  })
})

describe('mapGhosttyToOrca — macos-option-as-alt', () => {
  it('maps on to true', () => {
    const result = mapGhosttyToOrca({ 'macos-option-as-alt': 'on' }, true)
    expect(result.diff).toEqual({ terminalMacOptionAsAlt: 'true' })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps true to true', () => {
    const result = mapGhosttyToOrca({ 'macos-option-as-alt': 'true' }, true)
    expect(result.diff).toEqual({ terminalMacOptionAsAlt: 'true' })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps off to false', () => {
    const result = mapGhosttyToOrca({ 'macos-option-as-alt': 'off' }, true)
    expect(result.diff).toEqual({ terminalMacOptionAsAlt: 'false' })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps left to left', () => {
    const result = mapGhosttyToOrca({ 'macos-option-as-alt': 'left' }, true)
    expect(result.diff).toEqual({ terminalMacOptionAsAlt: 'left' })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps right to right', () => {
    const result = mapGhosttyToOrca({ 'macos-option-as-alt': 'right' }, true)
    expect(result.diff).toEqual({ terminalMacOptionAsAlt: 'right' })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid value', () => {
    const result = mapGhosttyToOrca({ 'macos-option-as-alt': 'maybe' }, true)
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['macos-option-as-alt'])
  })

  it('treats as unsupported on non-macOS', () => {
    const result = mapGhosttyToOrca({ 'macos-option-as-alt': 'true' }, false)
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['macos-option-as-alt'])
  })
})

describe('mapGhosttyToOrca — background & colors', () => {
  it('maps background-opacity to terminalBackgroundOpacity', () => {
    const result = mapGhosttyToOrca({ 'background-opacity': '0.72' })
    expect(result.diff).toEqual({ terminalBackgroundOpacity: 0.72 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('skips out-of-range background-opacity', () => {
    const result = mapGhosttyToOrca({ 'background-opacity': '1.5' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['background-opacity'])
  })

  it('skips negative background-opacity', () => {
    const result = mapGhosttyToOrca({ 'background-opacity': '-0.1' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['background-opacity'])
  })

  it('maps background-blur-radius > 0 to windowBackgroundBlur true', () => {
    const result = mapGhosttyToOrca({ 'background-blur-radius': '20' })
    expect(result.diff).toEqual({ windowBackgroundBlur: true })
    expect(result.unsupportedKeys).toEqual(['background-blur-radius (radius value not preserved)'])
  })

  it('maps background-blur-radius = 0 to windowBackgroundBlur false without a drop note', () => {
    // Why: 0 means blur is off — there is no radius value being lost, so the
    // "radius not preserved" note would be misleading here.
    const result = mapGhosttyToOrca({ 'background-blur-radius': '0' })
    expect(result.diff).toEqual({ windowBackgroundBlur: false })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid background-blur-radius', () => {
    const result = mapGhosttyToOrca({ 'background-blur-radius': 'heavy' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['background-blur-radius'])
  })

  it('maps background with hash to terminalColorOverrides.background', () => {
    const result = mapGhosttyToOrca({ background: '#111111' })
    expect(result.diff).toEqual({ terminalColorOverrides: { background: '#111111' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps background without hash to terminalColorOverrides.background', () => {
    const result = mapGhosttyToOrca({ background: '111111' })
    expect(result.diff).toEqual({ terminalColorOverrides: { background: '#111111' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps foreground to terminalColorOverrides.foreground', () => {
    const result = mapGhosttyToOrca({ foreground: '#eeeeee' })
    expect(result.diff).toEqual({ terminalColorOverrides: { foreground: '#eeeeee' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps foreground without hash to terminalColorOverrides.foreground', () => {
    const result = mapGhosttyToOrca({ foreground: 'eeeeee' })
    expect(result.diff).toEqual({ terminalColorOverrides: { foreground: '#eeeeee' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps cursor-color to terminalColorOverrides.cursor', () => {
    const result = mapGhosttyToOrca({ 'cursor-color': '#ff00ff' })
    expect(result.diff).toEqual({ terminalColorOverrides: { cursor: '#ff00ff' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps cursor-color without hash to terminalColorOverrides.cursor', () => {
    const result = mapGhosttyToOrca({ 'cursor-color': 'ff00ff' })
    expect(result.diff).toEqual({ terminalColorOverrides: { cursor: '#ff00ff' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps selection-background to terminalColorOverrides.selectionBackground', () => {
    const result = mapGhosttyToOrca({ 'selection-background': '#333333' })
    expect(result.diff).toEqual({ terminalColorOverrides: { selectionBackground: '#333333' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps selection-background without hash', () => {
    const result = mapGhosttyToOrca({ 'selection-background': '333333' })
    expect(result.diff).toEqual({ terminalColorOverrides: { selectionBackground: '#333333' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps selection-foreground to terminalColorOverrides.selectionForeground', () => {
    const result = mapGhosttyToOrca({ 'selection-foreground': '#cccccc' })
    expect(result.diff).toEqual({ terminalColorOverrides: { selectionForeground: '#cccccc' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps selection-foreground without hash', () => {
    const result = mapGhosttyToOrca({ 'selection-foreground': 'cccccc' })
    expect(result.diff).toEqual({ terminalColorOverrides: { selectionForeground: '#cccccc' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid hex color and continues parsing others', () => {
    const result = mapGhosttyToOrca({ foreground: '#12ZZ12', background: '#111111' })
    expect(result.diff).toEqual({ terminalColorOverrides: { background: '#111111' } })
    expect(result.unsupportedKeys).toEqual(['foreground'])
  })
})

describe('mapGhosttyToOrca — palette', () => {
  it('maps palette array to terminalColorOverrides ANSI fields', () => {
    const result = mapGhosttyToOrca({
      palette: ['0=#000000', '1=#ff0000', '3=#ffaa00', '15=#ffffff']
    })
    expect(result.diff).toEqual({
      terminalColorOverrides: {
        black: '#000000',
        red: '#ff0000',
        yellow: '#ffaa00',
        brightWhite: '#ffffff'
      }
    })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('treats palette with only unknown indices as unsupported', () => {
    const result = mapGhosttyToOrca({ palette: ['27=#abcdef'] })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['palette'])
  })

  it('ignores palette entries with invalid hex', () => {
    const result = mapGhosttyToOrca({ palette: ['0=#000000', '1=gggggg'] })
    expect(result.diff).toEqual({ terminalColorOverrides: { black: '#000000' } })
    expect(result.unsupportedKeys).toEqual([])
  })
})

describe('mapGhosttyToOrca — window & padding', () => {
  // Why: window-padding-color and window-padding-balance are not imported —
  // the CSS vars Orca sets for them have no consuming rules today, so the
  // mapper must treat the keys as unsupported rather than silently dropping.
  it('marks window-padding-color as unsupported', () => {
    const result = mapGhosttyToOrca({ 'window-padding-color': '#202020' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['window-padding-color'])
  })

  it('marks window-padding-balance as unsupported', () => {
    const result = mapGhosttyToOrca({ 'window-padding-balance': 'true' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['window-padding-balance'])
  })
})

describe('mapGhosttyToOrca — unsupported keys', () => {
  it('marks unknown keys as unsupported', () => {
    const result = mapGhosttyToOrca({ 'unknown-key': 'value' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['unknown-key'])
  })

  it('handles a mix of supported and unsupported keys', () => {
    const result = mapGhosttyToOrca({
      'font-family': 'Fira Code',
      'font-size': '13',
      'background-blur-radius': '20'
    })
    expect(result.diff).toEqual({
      terminalFontFamily: 'Fira Code',
      terminalFontSize: 13,
      windowBackgroundBlur: true
    })
    expect(result.unsupportedKeys).toEqual(['background-blur-radius (radius value not preserved)'])
  })

  it('marks all intentionally unsupported keys', () => {
    const result = mapGhosttyToOrca({
      'window-decoration': 'true',
      'window-step-resize': 'true',
      'window-height': '1000',
      'window-width': '1000',
      'gtk-tabs-location': 'top',
      'custom-shader': 'shader.glsl',
      keybind: 'ctrl+a=new_window'
    })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual([
      'window-decoration',
      'window-step-resize',
      'window-height',
      'window-width',
      'gtk-tabs-location',
      'custom-shader',
      'keybind'
    ])
  })
})
