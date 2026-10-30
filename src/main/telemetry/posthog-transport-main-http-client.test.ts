import { afterEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'
import { createPostHogClient } from './posthog-transport'

describe('PostHog transport', () => {
  const mainFetch = vi.fn(async () => new Response('{}', { status: 200 }))
  const globalFetch = vi.fn(async () => new Response('{}', { status: 200 }))

  afterEach(() => {
    setMainHttpClient(null)
    vi.unstubAllGlobals()
    mainFetch.mockClear()
    globalFetch.mockClear()
  })

  const capture = async (consent: Parameters<typeof createPostHogClient>[1]) => {
    vi.stubGlobal('fetch', globalFetch)
    setMainHttpClient({ fetch: mainFetch, proxySession: () => null })
    const client = createPostHogClient('test-key', consent)
    client.capture({ distinctId: 'install-1', event: 'app_opened' })
    await client.shutdown()
  }

  // The desktop client sends through the session that carries the user's proxy.
  it('sends through the main HTTP client, not global fetch', async () => {
    await capture({ effective: 'enabled' })
    expect(mainFetch).toHaveBeenCalledWith(
      expect.stringContaining('/batch'),
      expect.objectContaining({ method: 'POST', credentials: 'omit' })
    )
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('sends nothing when telemetry is disabled', async () => {
    await capture({ effective: 'disabled', reason: 'user_opt_out' })
    expect(mainFetch).not.toHaveBeenCalled()
    expect(globalFetch).not.toHaveBeenCalled()
  })
})
