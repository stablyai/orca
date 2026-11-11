import { describe, expect, it } from 'vitest'
import { fetchUsageHistory } from './billing-usage-client'

const endpoints = {
  billingApiUrl: 'https://billing.example.test',
  billingTokenEndpoint: 'https://login.example.test/v1/desktop/auth/billing-token'
}

type Seen = { url: string; init: RequestInit | undefined }

function fakeFetch(responses: Record<string, Response>, seen: Seen[] = []): typeof fetch {
  return async (input, init) => {
    const url = String(input)
    seen.push({ url, init })
    const response = responses[url]
    if (!response) {
      throw new Error(`unexpected ${url}`)
    }
    return response
  }
}

describe('fetchUsageHistory', () => {
  const url = 'https://billing.example.test/v1/billing/usage?utcOffset=-480'
  const body = {
    days: [{ start: 1, seconds: 3600 }],
    totalSeconds: 3600,
    yourSeconds: 1800,
    members: { top: [{ userId: 'u1', seconds: 3600 }], otherCount: 0, otherSeconds: 0 },
    sandboxes: { top: [{ sandboxId: 'sbx_1', seconds: 3600 }], otherCount: 0, otherSeconds: 0 }
  }

  it('sends the local offset and maps both breakdowns to one row shape', async () => {
    const seen: Seen[] = []
    const history = await fetchUsageHistory(
      endpoints,
      'bt',
      -480,
      fakeFetch({ [url]: Response.json(body) }, seen)
    )
    expect(seen[0]!.init?.method).toBe('GET')
    expect(history.members).toEqual({
      top: [{ id: 'u1', seconds: 3600 }],
      otherCount: 0,
      otherSeconds: 0
    })
    expect(history.sandboxes?.top).toEqual([{ id: 'sbx_1', seconds: 3600 }])
  })

  it('accepts a member’s view and rejects malformed rows', async () => {
    const member = await fetchUsageHistory(
      endpoints,
      'bt',
      -480,
      fakeFetch({ [url]: Response.json({ ...body, members: null, sandboxes: null }) })
    )
    expect(member.members).toBeNull()
    await expect(
      fetchUsageHistory(
        endpoints,
        'bt',
        -480,
        fakeFetch({
          [url]: Response.json({
            ...body,
            members: { top: [{ userId: '<script>', seconds: 1 }], otherCount: 0, otherSeconds: 0 }
          })
        })
      )
    ).rejects.toThrow('invalid_billing_response')
  })
})
