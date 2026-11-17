import { describe, expect, it } from 'vitest'
import { parseAntigravityUsageEnvelope } from './antigravity-usage-response'

describe('parseAntigravityUsageEnvelope', () => {
  it("strips agy's 'Limit Remaining' suffix from bucket names", () => {
    const reading = parseAntigravityUsageEnvelope({
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                {
                  id: 'gemini-weekly',
                  name: 'Weekly Limit Remaining',
                  window: 'weekly',
                  remaining_fraction: 0.58
                },
                {
                  id: 'gemini-5h',
                  name: 'Five Hour Limit Remaining',
                  window: '5h',
                  remaining_fraction: 1
                }
              ]
            }
          ]
        }
      }
    })

    expect(reading?.buckets.map((bucket) => bucket.name)).toEqual([
      'Gemini Models · Weekly',
      'Gemini Models · Five Hour'
    ])
  })
})
