import { afterEach, describe, expect, it } from 'vitest'
import { setMainHttpClient } from '../../../network/http-client'
import { fetchOpenCodeGoUsageWithApiKey } from './opencode-go-usage-api'

const ENTITLEMENT_BODY = JSON.stringify({
  type: 'error',
  error: { type: 'EntitlementError', message: 'OpenCode Go subscription required.' }
})

function respondWith(status: number, body: string, contentType: string): void {
  setMainHttpClient({
    fetch: async () => new Response(body, { status, headers: { 'Content-Type': contentType } }),
    proxySession: () => null
  })
}

describe('fetchOpenCodeGoUsageWithApiKey failure classification', () => {
  afterEach(() => setMainHttpClient(null))

  it.each([
    ['entitlement 403', 403, ENTITLEMENT_BODY, 'application/json', 'no-subscription'],
    ['edge block page', 403, '<html><title>Access denied</title></html>', 'text/html', 'failed']
  ])('maps %s to its outcome', async (_case, status, body, contentType, kind) => {
    respondWith(status, body, contentType)
    const outcome = await fetchOpenCodeGoUsageWithApiKey('placeholder-go-key')
    expect(outcome.kind).toBe(kind)
  })
})
