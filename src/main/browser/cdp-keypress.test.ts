import { describe, expect, it } from 'vitest'
import { resolveCdpKeypressDefinition } from './cdp-keypress'

describe('resolveCdpKeypressDefinition', () => {
  it('maps navigation keys with Chromium virtual key metadata', () => {
    expect(resolveCdpKeypressDefinition('Tab')).toEqual({
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      text: '\t'
    })
  })

  it('maps modifiers without sending text to Chromium', () => {
    expect(resolveCdpKeypressDefinition('Control+Shift+r')).toEqual({
      key: 'r',
      code: 'KeyR',
      windowsVirtualKeyCode: 82,
      text: undefined,
      modifiers: 10
    })
  })

  it('preserves plus as the key after modifier prefixes', () => {
    expect(resolveCdpKeypressDefinition('Control++')).toMatchObject({
      key: '+',
      text: undefined,
      modifiers: 2
    })
  })

  it('preserves text for Shift-only printable keys', () => {
    expect(resolveCdpKeypressDefinition('Shift+A')).toEqual({
      key: 'A',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      text: 'A',
      modifiers: 8
    })
  })

  it('omits text for Shift-only non-printable keys', () => {
    expect(resolveCdpKeypressDefinition('Shift+Tab')).toEqual({
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      text: undefined,
      modifiers: 8
    })
  })
})
