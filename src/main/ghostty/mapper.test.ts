import { describe, expect, it } from 'vitest'
import { mapGhosttyToOrca } from './mapper'

describe('mapGhosttyToOrca', () => {
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

  it('marks unsupported keys as unsupported', () => {
    const result = mapGhosttyToOrca({
      background: '#1a1a1a',
      foreground: '#ffffff',
      'unknown-key': 'value'
    })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['background', 'foreground', 'unknown-key'])
  })

  it('handles a mix of supported and unsupported keys', () => {
    const result = mapGhosttyToOrca({
      'font-family': 'Fira Code',
      'font-size': '13',
      background: '#000000'
    })
    expect(result.diff).toEqual({
      terminalFontFamily: 'Fira Code',
      terminalFontSize: 13
    })
    expect(result.unsupportedKeys).toEqual(['background'])
  })

  it('skips invalid font-size values', () => {
    const result = mapGhosttyToOrca({
      'font-size': 'not-a-number'
    })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['font-size'])
  })

  it('skips invalid cursor-style values', () => {
    const result = mapGhosttyToOrca({
      'cursor-style': 'beam'
    })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['cursor-style'])
  })

  it('returns zero font-size as unsupported', () => {
    const result = mapGhosttyToOrca({
      'font-size': '0'
    })
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
