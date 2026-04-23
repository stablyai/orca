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
})
