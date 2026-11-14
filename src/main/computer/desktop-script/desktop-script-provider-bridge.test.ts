import { describe, expect, it } from 'vitest'
import { mapBridgeError } from './desktop-script-provider-bridge'

describe('mapBridgeError', () => {
  it('keeps the code a provider refusal names', () => {
    expect(
      mapBridgeError(
        'element_not_enabled: element 4 is disabled, so no input was sent; run get-app-state and use a fresh element index'
      ).code
    ).toBe('element_not_enabled')
  })
})
