import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agent } from 'undici'

const electronFetch = vi.hoisted(() =>
  vi.fn<typeof globalThis.fetch>(async () => Response.json({ boundary: 'electron' }))
)

vi.mock('electron', () => ({ net: { fetch: electronFetch } }))

import { firstPartyFetch } from './first-party-fetch'

describe('first-party fetch', () => {
  afterEach(() => {
    Reflect.deleteProperty(process.versions, 'electron')
    Reflect.deleteProperty(process, 'type')
    electronFetch.mockClear()
    vi.unstubAllGlobals()
  })

  it('uses the injected Node fetch outside Electron', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetch)
    await expect(firstPartyFetch('https://cloud.example')).resolves.toMatchObject({ ok: true })
    expect(fetch).toHaveBeenCalledWith('https://cloud.example', {
      dispatcher: expect.any(Agent)
    })
  })

  it('uses Electron networking for first-party HTTP in the desktop runtime', async () => {
    Object.defineProperty(process.versions, 'electron', { value: '43.1.0', configurable: true })
    Object.defineProperty(process, 'type', { value: 'browser', configurable: true })
    const url = new URL('https://cloud.example/session')
    await expect(firstPartyFetch(url, { method: 'POST' })).resolves.toMatchObject({ ok: true })
    expect(electronFetch).toHaveBeenCalledWith(url.toString(), { method: 'POST' })
  })

  it('keeps the Node boundary when Electron runs as a headless Node process', async () => {
    Object.defineProperty(process.versions, 'electron', { value: '43.1.0', configurable: true })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ boundary: 'node' }))
    vi.stubGlobal('fetch', fetch)
    await firstPartyFetch('https://cloud.example')
    expect(fetch).toHaveBeenCalledOnce()
    expect(electronFetch).not.toHaveBeenCalled()
  })
})
