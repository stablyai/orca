import { describe, expect, it } from 'vitest'
import { mapBridgeError } from './desktop-script-provider-bridge'

describe('mapBridgeError', () => {
  it('keeps the code a provider refusal names', () => {
    expect(
      mapBridgeError(
        'element_not_enabled: element 4 is disabled, so no input was sent; run get-app-state and use a fresh element index'
      ).code
    ).toBe('element_not_enabled')
    expect(
      mapBridgeError(
        "unsupported_capability: Linux computer use can't reach the AT-SPI accessibility bus, so nothing was sent."
      ).code
    ).toBe('unsupported_capability')
  })
})
