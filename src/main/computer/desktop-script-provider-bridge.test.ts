import { describe, expect, it } from 'vitest'
import { mapBridgeError } from './desktop-script-provider-bridge'

describe('mapBridgeError', () => {
  it('maps native window-not-found messages without broad false positives', () => {
    expect(mapBridgeError('No top-level AT-SPI window is available for Text Editor').code).toBe(
      'window_not_found'
    )
    expect(mapBridgeError("app 'Finder' has no on-screen window").code).toBe('window_not_found')
    expect(mapBridgeError('Failed to execute window operation').code).toBe('accessibility_error')
  })

  it('maps native element-not-found messages without broad false positives', () => {
    expect(
      mapBridgeError('stale element frame; run get-app-state again and use a fresh element index')
        .code
    ).toBe('element_not_found')
    expect(mapBridgeError('unknown element_index').code).toBe('element_not_found')
    expect(mapBridgeError('element metadata unavailable').code).toBe('accessibility_error')
  })
})
