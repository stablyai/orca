import { describe, expect, it, vi } from 'vitest'
import {
  downloadWebStoreCrx,
  fetchWebStoreIconDataUrl
} from './browser-extension-webstore-download'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

const EXTENSION_ID = 'nngceckbapebfimnlniiiahkandclblb'
const ICON_URL = 'https://lh3.googleusercontent.com/icon.png'

function responseFetcher(response: Response) {
  const signals: AbortSignal[] = []
  return {
    signals,
    fetcher: async (_url: string, init?: RequestInit): Promise<Response> => {
      if (init?.signal) {
        signals.push(init.signal)
      }
      return response
    }
  }
}

const rejectedResponses: {
  kind: 'crx' | 'icon'
  status: number
  headers: Record<string, string>
  error: string
}[] = [
  { kind: 'crx', status: 503, headers: {}, error: 'Chrome Web Store download failed (503)' },
  {
    kind: 'crx',
    status: 200,
    headers: { 'content-length': String(256 * 1024 * 1024 + 1) },
    error: 'Download is too large'
  },
  {
    kind: 'icon',
    status: 200,
    headers: { 'content-type': 'text/html' },
    error: 'Icon could not be loaded'
  },
  {
    kind: 'icon',
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(1024 * 1024 + 1) },
    error: 'Download is too large'
  }
]

describe('Web Store download request ownership', () => {
  it.each(rejectedResponses)(
    'retires $kind after rejecting response metadata: $error',
    async (scenario) => {
      const { fetcher, signals } = responseFetcher(
        new Response(new ReadableStream(), { status: scenario.status, headers: scenario.headers })
      )
      const download =
        scenario.kind === 'crx'
          ? downloadWebStoreCrx(EXTENSION_ID, { fetcher })
          : fetchWebStoreIconDataUrl(ICON_URL, fetcher)

      await expect(download).rejects.toThrow(scenario.error)
      expect(signals).toHaveLength(1)
      expect(signals[0].aborted).toBe(true)
    }
  )

  it('preserves the streaming byte cap and retires the rejected transfer', async () => {
    const cancel = vi.fn()
    const { fetcher, signals } = responseFetcher(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1))
          },
          cancel
        }),
        { headers: { 'content-type': 'image/png' } }
      )
    )

    await expect(fetchWebStoreIconDataUrl(ICON_URL, fetcher)).rejects.toThrow(
      'Download is too large'
    )
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(true)
  })

  it('still rejects an invalid package after consuming its complete response', async () => {
    const { fetcher, signals } = responseFetcher(new Response('bad'))

    await expect(downloadWebStoreCrx(EXTENSION_ID, { fetcher })).rejects.toThrow('Not a CRX file')
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(true)
  })

  it('keeps an overlapping healthy icon alive until its own bytes finish', async () => {
    let finishHealthy = (): void => {}
    const healthyResponse = new Response(
      new ReadableStream({
        start(controller) {
          finishHealthy = () => {
            controller.enqueue(new Uint8Array([1, 2, 3]))
            controller.close()
          }
        }
      }),
      { headers: { 'content-type': 'image/png' } }
    )
    const healthy = responseFetcher(healthyResponse)
    const failed = responseFetcher(new Response('bad', { status: 503 }))
    const pendingHealthy = fetchWebStoreIconDataUrl(ICON_URL, healthy.fetcher)

    try {
      await expect(downloadWebStoreCrx(EXTENSION_ID, { fetcher: failed.fetcher })).rejects.toThrow(
        'Chrome Web Store download failed (503)'
      )
      expect(failed.signals).toHaveLength(1)
      expect(failed.signals[0].aborted).toBe(true)
      expect(healthy.signals).toHaveLength(1)
      expect(healthy.signals[0].aborted).toBe(false)
      expect(healthy.signals[0]).not.toBe(failed.signals[0])
    } finally {
      finishHealthy()
    }
    await expect(pendingHealthy).resolves.toBe('data:image/png;base64,AQID')
    expect(healthy.signals[0].aborted).toBe(true)
  })
})
