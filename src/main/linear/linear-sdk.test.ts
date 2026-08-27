import { afterEach, describe, expect, it, vi } from 'vitest'

const dispatcher = { dispatch: () => true }

async function loadSdkModule() {
  vi.resetModules()
  vi.doMock('./linear-api-dispatcher', () => ({
    getLinearApiDispatcher: () => dispatcher
  }))
  return import('./linear-sdk')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createLinearClient', () => {
  // Why: @linear/sdk builds its own request and calls global fetch, so the only
  // lever we have is the option pass-through it spreads into fetch init. If a
  // future SDK release stops forwarding it, Linear silently falls back to Node's
  // bundled trust and orca#12189 returns.
  it('routes Linear requests through the system-trust dispatcher', async () => {
    const { createLinearClient } = await loadSdkModule()
    const fetchStub = vi.fn(
      async (_url: string, _init: RequestInit & { dispatcher?: unknown }) =>
        new Response(JSON.stringify({ data: { viewer: { id: 'user-1', name: 'Ada' } } }), {
          headers: { 'content-type': 'application/json' }
        })
    )
    vi.stubGlobal('fetch', fetchStub)

    await createLinearClient({ apiKey: 'api-key' }).viewer

    expect(fetchStub).toHaveBeenCalledTimes(1)
    const [url, init] = fetchStub.mock.calls[0]!
    expect(url).toBe('https://api.linear.app/graphql')
    expect(init.dispatcher).toBe(dispatcher)
  })

  it('falls back to default trust when no dispatcher could be built', async () => {
    vi.resetModules()
    vi.doMock('./linear-api-dispatcher', () => ({
      getLinearApiDispatcher: () => undefined
    }))
    const { createLinearClient } = await import('./linear-sdk')
    const fetchStub = vi.fn(
      async (_url: string, _init: Record<string, unknown>) =>
        new Response(JSON.stringify({ data: { viewer: { id: 'user-1' } } }), {
          headers: { 'content-type': 'application/json' }
        })
    )
    vi.stubGlobal('fetch', fetchStub)

    await createLinearClient({ apiKey: 'api-key' }).viewer

    const [, init] = fetchStub.mock.calls[0]!
    expect('dispatcher' in init).toBe(false)
  })
})
