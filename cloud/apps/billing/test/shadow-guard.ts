// Shadow project (vitest.config.ts): after every test, the grant resolver must have agreed with
// the legacy computation on every entitlement it was asked for. This is the parity bar for
// switching ENTITLEMENTS_MODE to 'on'.
import { afterEach, expect } from 'vitest'
import { liveHarnesses } from './harness'

afterEach(() => {
  const harnesses = liveHarnesses.splice(0)
  for (const harness of harnesses) {
    if (harness.env.ENTITLEMENTS_MODE !== 'shadow') {
      continue
    }
    const diffs = harness.raw.prepare('SELECT account_id, surface, diff_json FROM entitlement_shadow_diffs').all()
    expect(diffs).toEqual([])
  }
})
