import { describe, expect, it } from 'vitest'
import { parseOpenCodeGoBillingStatusPayload } from './opencode-go-status-parsing'

describe('parseOpenCodeGoBillingStatusPayload', () => {
  it('maps the verified PAYG micro-cent string into USD major units', () => {
    expect(
      parseOpenCodeGoBillingStatusPayload(
        JSON.stringify({
          billingMode: 'prepaid',
          mode: 'pay-as-you-go',
          balanceMicroCents: '2786781005'
        })
      )
    ).toBe(27.86781005)
  })
})
