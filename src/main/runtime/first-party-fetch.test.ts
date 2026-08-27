import { afterEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'
import { firstPartyFetch } from './first-party-fetch'

describe('first-party fetch', () => {
  afterEach(() => {
    setMainHttpClient(null)
    vi.unstubAllGlobals()
  })

  it('uses the installed HTTP transport with a fixed first-party policy', async () => {
    const fetchWithSystemTrust = vi.fn(async () => Response.json({ boundary: 'installed' }))
    setMainHttpClient({
      fetch: vi.fn(),
      fetchWithSystemTrust,
      proxySession: () => null
    })
    const url = new URL('https://cloud.example/session')
    await expect(
      firstPartyFetch(url, {
        method: 'POST',
        cache: 'force-cache',
        credentials: 'include',
        redirect: 'follow'
      })
    ).resolves.toMatchObject({ ok: true })
    expect(fetchWithSystemTrust).toHaveBeenCalledWith(url, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error'
    })
  })
})
