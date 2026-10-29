import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FetchResponseBodyTooLargeError } from '../../shared/fetch-response-body'
import { setMainHttpClient } from '../network/http-client'
import type { JiraClientForSite } from './authenticated-request'
import { listFavouriteFilters } from './favourite-filters'
import { JiraApiError } from './jira-api-error'

const { getClients } = vi.hoisted(() => ({ getClients: vi.fn() }))
vi.mock('./client', () => ({ getClients }))
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
  site: {
    id: 'site-1',
    siteUrl: 'https://jira.test',
    email: '',
    displayName: 'Jira',
    accountId: 'me'
  },
  authorization: 'Bearer fixture-token'
}
const maxBytes = 2 * 1024 * 1024
const filter = { id: '1', name: 'Mine', jql: 'assignee = currentUser()' }
const encoder = new TextEncoder()

function installTransport(read: (signal: AbortSignal) => Promise<Response>) {
  const started = Promise.withResolvers<AbortSignal>()
  const aborted = vi.fn()
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const signal = init?.signal
    if (!signal) {
      throw new Error('Expected an operation signal')
    }
    signal.addEventListener('abort', aborted, { once: true })
    started.resolve(signal)
    return read(signal)
  })
  setMainHttpClient({ fetch, proxySession: () => null })
  return { started: started.promise, aborted, fetch }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  getClients.mockReturnValue([client])
})

afterEach(() => {
  setMainHttpClient(null)
  vi.useRealTimers()
})

describe('favourite filter transport ownership', () => {
  it.each(['declared', 'streamed'] as const)(
    'aborts a rejected %s oversized response without aborting the caller',
    async (kind) => {
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (kind === 'streamed') {
            controller.enqueue(new Uint8Array(maxBytes + 1))
          }
        },
        cancel
      })
      const response = new Response(body, {
        headers: kind === 'declared' ? { 'content-length': String(maxBytes + 1) } : {}
      })
      const transport = installTransport(async () => response)
      const parent = new AbortController()

      await expect(listFavouriteFilters('site-1', parent.signal)).rejects.toEqual(
        new FetchResponseBodyTooLargeError(maxBytes + 1, maxBytes)
      )

      expect(cancel).toHaveBeenCalledOnce()
      expect(transport.aborted).toHaveBeenCalledOnce()
      expect(parent.signal.aborted).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('consumes the complete JSON body before retiring a successful transport', async () => {
    const body = new TransformStream<Uint8Array, Uint8Array>()
    const writer = body.writable.getWriter()
    const transport = installTransport(async () => new Response(body.readable))
    const parent = new AbortController()
    const finished = vi.fn()
    const read = listFavouriteFilters('site-1', parent.signal).finally(finished)
    const signal = await transport.started

    await writer.write(encoder.encode('['))
    expect(signal.aborted).toBe(false)
    expect(finished).not.toHaveBeenCalled()
    await writer.write(encoder.encode(`${JSON.stringify(filter)}]`))
    expect(signal.aborted).toBe(false)
    await writer.close()

    await expect(read).resolves.toEqual({
      filters: [{ ...filter, siteId: 'site-1' }],
      truncated: false
    })
    expect(transport.aborted).toHaveBeenCalledOnce()
    expect(parent.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['transport', 'body'] as const)('preserves the original %s error', async (kind) => {
    const error = new Error(`${kind} failed`)
    const transport = installTransport(async () => {
      if (kind === 'transport') {
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
    const parent = new AbortController()

    await expect(listFavouriteFilters('site-1', parent.signal)).rejects.toBe(error)

    expect(transport.aborted).toHaveBeenCalledOnce()
    expect(parent.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves HTTP status when an oversized error body is cancelled', async () => {
    const cancel = vi.fn()
    const transport = installTransport(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          status: 403,
          statusText: 'Forbidden',
          headers: { 'content-length': String(maxBytes + 1) }
        })
    )

    await expect(listFavouriteFilters('site-1')).rejects.toEqual(new JiraApiError('Forbidden', 403))

    expect(cancel).toHaveBeenCalledOnce()
    expect(transport.aborted).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an active request at the deadline without aborting the caller', async () => {
    const error = new DOMException('fixture request aborted', 'AbortError')
    const transport = installTransport(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(error), { once: true })
        })
    )
    const parent = new AbortController()
    const read = listFavouriteFilters('site-1', parent.signal)
    const rejected = expect(read).rejects.toBe(error)
    await transport.started

    await vi.advanceTimersByTimeAsync(24_999)
    expect(transport.aborted).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await rejected
    expect(transport.aborted).toHaveBeenCalledOnce()
    expect(parent.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
