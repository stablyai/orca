import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jiraRequestBinary, type JiraClientForSite } from './authenticated-request'

const { fetchImage } = vi.hoisted(() => ({ fetchImage: vi.fn<typeof fetch>() }))
vi.mock('../network/http-client', () => ({
  getMainHttpClient: () => ({ fetch: fetchImage, proxySession: () => null })
}))
vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../observability/tracer', () => ({
  withSpan: (
    _name: string,
    run: (span: { setAttribute: () => void; addEvent: () => void }) => Promise<unknown>
  ) => run({ setAttribute: () => {}, addEvent: () => {} })
}))
const client: JiraClientForSite = {
  site: { id: 'site', siteUrl: 'https://jira.test', email: '', accountId: '', displayName: '' },
  authorization: 'secret'
}
beforeEach(() => {
  fetchImage.mockReset()
})

describe('bounded Jira attachment downloads', () => {
  it('rejects oversized declared bodies before consuming any bytes', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': '9' }
    })
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer')
    fetchImage.mockResolvedValue(response)
    await expect(jiraRequestBinary(client, '/image', { maxBytes: 8 })).rejects.toThrow('byte limit')
    expect(cancel).toHaveBeenCalledOnce()
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(fetchImage.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })
  it('caps chunked bodies even when Content-Length is missing', async () => {
    let part = 0
    const cancel = vi.fn()
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(Uint8Array.from([++part, 0, 0]))
        },
        cancel
      })
    )
    fetchImage.mockResolvedValue(response)
    await expect(jiraRequestBinary(client, '/image', { maxBytes: 8 })).rejects.toThrow('byte limit')
    expect(cancel).toHaveBeenCalledOnce()
    expect(part).toBeLessThanOrEqual(4)
    expect(fetchImage.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })
  it('returns complete bytes and releases its transport without aborting the caller', async () => {
    const controller = new AbortController()
    fetchImage.mockResolvedValue(
      new Response(Uint8Array.from([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    )
    expect(
      await jiraRequestBinary(client, '/image', { maxBytes: 8, signal: controller.signal })
    ).toEqual({ data: Uint8Array.from([1, 2, 3]).buffer, contentType: 'image/png' })
    expect(fetchImage).toHaveBeenCalledWith(
      'https://jira.test/image',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(fetchImage.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(controller.signal.aborted).toBe(false)
  })
  it.each(['transport', 'body'] as const)(
    'preserves the original %s error while releasing its request',
    async (failure) => {
      const error = new Error('original failure')
      fetchImage.mockImplementation(async () => {
        if (failure === 'transport') {
          throw error
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(error)
            }
          })
        )
      })
      await expect(jiraRequestBinary(client, '/image')).rejects.toBe(error)
      expect(fetchImage.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    }
  )
  it('releases a rejected HTTP response while keeping its Jira status', async () => {
    fetchImage.mockResolvedValue(new Response('denied', { status: 403, statusText: 'Forbidden' }))
    await expect(jiraRequestBinary(client, '/image')).rejects.toMatchObject({ status: 403 })
    expect(fetchImage.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })
  it.each([false, true])(
    'forwards caller cancellation and its reason (already aborted=%s)',
    async (alreadyAborted) => {
      const caller = new AbortController()
      const error = new Error('caller cancelled')
      if (alreadyAborted) {
        caller.abort(error)
      }
      const started = Promise.withResolvers<void>()
      fetchImage.mockImplementation(async (_url, init) => {
        const signal = init?.signal
        if (!signal) {
          throw new Error('Expected request cancellation signal')
        }
        if (signal.aborted) {
          throw signal.reason
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener('abort', () => controller.error(signal.reason), {
                once: true
              })
              started.resolve()
            }
          })
        )
      })
      const reading = jiraRequestBinary(client, '/image', { signal: caller.signal })
      if (!alreadyAborted) {
        await started.promise
        caller.abort(error)
      }
      await expect(reading).rejects.toBe(error)
      expect(fetchImage.mock.calls[0]?.[1]?.signal?.reason).toBe(error)
    }
  )
})
