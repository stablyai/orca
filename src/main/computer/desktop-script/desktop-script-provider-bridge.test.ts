import { describe, expect, it } from 'vitest'
import { mapBridgeError } from './desktop-script-provider-bridge'

describe('mapBridgeError', () => {
  it('keeps the code a provider refusal names', () => {
    expect(
      mapBridgeError(
        'background_unavailable: a click by coordinates needs the real mouse; nothing was sent. Click an element by --element-index instead.'
      ).code
    ).toBe('background_unavailable')
    expect(
      mapBridgeError(
        'element_not_enabled: element 4 is disabled, so no input was sent; run get-app-state and use a fresh element index'
      ).code
    ).toBe('element_not_enabled')
  })
})
