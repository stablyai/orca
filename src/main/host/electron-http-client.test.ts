import { describe, expect, it, vi } from 'vitest'

const netFetch = vi.hoisted(() => vi.fn(async () => new Response('ok')))

vi.mock('electron', () => ({
  net: { fetch: netFetch },
  session: { defaultSession: {} }
}))

import { electronHttpClient } from './electron-http-client'

describe('Electron HTTP client', () => {
  it('forwards the isolated first-party request policy to Chromium', async () => {
    const init: RequestInit = {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error'
    }
    await electronHttpClient.fetchWithSystemTrust(new URL('https://cloud.example/session'), init)
    expect(netFetch).toHaveBeenCalledWith('https://cloud.example/session', init)
  })
})
