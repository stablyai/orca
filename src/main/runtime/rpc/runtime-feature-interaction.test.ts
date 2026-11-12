import { describe, expect, it } from 'vitest'
import { getRuntimeFeatureInteractionId } from './runtime-feature-interaction'

describe('runtime feature interaction for cookie import', () => {
  it('records a successful bulk cookie import as cookie-import', () => {
    expect(getRuntimeFeatureInteractionId('browser.cookie.import', { ok: true })).toBe(
      'cookie-import'
    )
    expect(getRuntimeFeatureInteractionId('browser.cookie.import', { ok: false })).toBeNull()
  })
})
