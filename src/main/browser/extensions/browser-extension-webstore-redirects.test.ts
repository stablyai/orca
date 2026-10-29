import { describe, expect, it, vi } from 'vitest'
import {
  downloadWebStoreCrx,
  fetchWebStoreIconDataUrl
} from './browser-extension-webstore-download'

vi.mock('electron', () => ({ net: { request: vi.fn() } }))

const EXTENSION_ID = 'nngceckbapebfimnlniiiahkandclblb'
const ICON_URL = 'https://lh3.googleusercontent.com/path/icon.png'
const CRX_URL = 'https://clients2.google.com/service/update2/crx'
const scenarios = [
  { kind: 'icon', url: ICON_URL, error: 'Icon could not be loaded' },
  { kind: 'crx', url: CRX_URL, error: 'Extension download was redirected away from Google' }
] as const

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

function download(kind: 'icon' | 'crx', fetcher: Fetcher) {
  return kind === 'icon'
    ? fetchWebStoreIconDataUrl(ICON_URL, fetcher)
    : downloadWebStoreCrx(EXTENSION_ID, { url: CRX_URL, fetcher })
}

describe('Web Store redirect policy', () => {
  it.each([
    { status: 301, location: '../final.png', final: 'https://lh3.googleusercontent.com/final.png' },
    {
      status: 302,
      location: 'https://www.gstatic.com/final.png',
      final: 'https://www.gstatic.com/final.png'
    },
    { status: 307, location: '/final.png', final: 'https://lh3.googleusercontent.com/final.png' }
  ])('loads an allowed $status redirect with its final exact bytes', async (scenario) => {
    const cancel = vi.fn()
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), {
          status: scenario.status,
          headers: { location: scenario.location }
        })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/png' }
        })
      )

    await expect(fetchWebStoreIconDataUrl(ICON_URL, fetcher)).resolves.toBe(
      'data:image/png;base64,AQID'
    )
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([ICON_URL, scenario.final])
    expect(
      fetcher.mock.calls.every(
        ([, init]) => init?.redirect === 'manual' && init.credentials === 'omit'
      )
    ).toBe(true)
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each(scenarios)(
    'rejects a foreign intermediate $kind host before making its request',
    async (scenario) => {
      const cancel = vi.fn()
      const fetcher = vi.fn<Fetcher>().mockResolvedValue(
        new Response(new ReadableStream({ cancel }), {
          status: 302,
          headers: { location: 'https://foreign.invalid/back-to-google' }
        })
      )

      await expect(download(scenario.kind, fetcher)).rejects.toThrow(scenario.error)
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([scenario.url])
      expect(fetcher.mock.calls[0][1]?.redirect).toBe('manual')
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
      expect(cancel).toHaveBeenCalledOnce()
    }
  )

  it('still verifies an allowed redirected package', async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(
        Response.redirect('https://downloads.googleusercontent.com/extension.crx')
      )
      .mockResolvedValueOnce(new Response('bad'))

    await expect(download('crx', fetcher)).rejects.toThrow('Not a CRX file')
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      CRX_URL,
      'https://downloads.googleusercontent.com/extension.crx'
    ])
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true)
  })

  it.each(scenarios)(
    'bounds a $kind redirect cycle and cancels every unused body',
    async (scenario) => {
      const cancel = vi.fn()
      const fetcher = vi.fn<Fetcher>().mockImplementation(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            status: 302,
            headers: { location: '/loop' }
          })
      )

      await expect(download(scenario.kind, fetcher)).rejects.toThrow(
        'Download has too many redirects'
      )
      expect(fetcher).toHaveBeenCalledTimes(21)
      expect(cancel).toHaveBeenCalledTimes(21)
      expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true)
    }
  )
})
