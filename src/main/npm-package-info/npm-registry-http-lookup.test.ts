import { beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetchMock, cancelUnreadResponseBodyMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  cancelUnreadResponseBodyMock: vi.fn()
}))

vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))
vi.mock('../lib/unread-response-body', () => ({
  cancelUnreadResponseBody: cancelUnreadResponseBodyMock
}))

const { npmRegistryHttpLookup } = await import('./npm-registry-http-lookup')

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body)
  }
}

describe('npmRegistryHttpLookup', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
    cancelUnreadResponseBodyMock.mockReset()
  })

  it('fetches the public registry with an 8s abort timeout', async () => {
    netFetchMock.mockResolvedValue(
      jsonResponse({ name: 'react', 'dist-tags': { latest: '19.0.0' } })
    )

    await npmRegistryHttpLookup('react')

    expect(netFetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = netFetchMock.mock.calls[0]!
    expect(url).toBe('https://registry.npmjs.org/react')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('encodes only the slash of a scoped package name', async () => {
    netFetchMock.mockResolvedValue(
      jsonResponse({ name: '@types/node', 'dist-tags': { latest: '22.0.0' } })
    )

    await npmRegistryHttpLookup('@types/node')

    const [url] = netFetchMock.mock.calls[0]!
    expect(url).toBe('https://registry.npmjs.org/@types%2Fnode')
  })

  it('returns ok with the full-document fields, not the abbreviated install doc', async () => {
    netFetchMock.mockResolvedValue(
      jsonResponse({
        name: 'react',
        description: 'React library',
        'dist-tags': { latest: '19.0.0' },
        time: { '19.0.0': '2024-12-05T00:00:00.000Z' },
        homepage: 'https://react.dev',
        repository: { type: 'git', url: 'git+https://github.com/facebook/react.git' }
      })
    )

    const result = await npmRegistryHttpLookup('react')

    expect(result).toEqual({
      status: 'ok',
      info: {
        packageName: 'react',
        description: 'React library',
        latestVersion: '19.0.0',
        latestPublishedAt: '2024-12-05T00:00:00.000Z',
        homepageUrl: 'https://react.dev/',
        repositoryUrl: 'https://github.com/facebook/react.git',
        source: 'registry-http'
      }
    })
  })

  it('maps a 404 to not-found and cancels the unread body', async () => {
    const response = jsonResponse({}, { ok: false, status: 404 })
    netFetchMock.mockResolvedValue(response)

    const result = await npmRegistryHttpLookup('does-not-exist')

    expect(result).toEqual({ status: 'not-found' })
    expect(cancelUnreadResponseBodyMock).toHaveBeenCalledWith(response)
  })

  it('maps a 5xx response to unavailable with reason error', async () => {
    netFetchMock.mockResolvedValue(jsonResponse({}, { ok: false, status: 503 }))

    const result = await npmRegistryHttpLookup('react')

    expect(result).toEqual({ status: 'unavailable', reason: 'error' })
  })

  it('maps an aborted-by-timeout fetch to unavailable with reason timeout', async () => {
    const timeoutError = new Error('The operation timed out.')
    timeoutError.name = 'TimeoutError'
    netFetchMock.mockRejectedValue(timeoutError)

    const result = await npmRegistryHttpLookup('react')

    expect(result).toEqual({ status: 'unavailable', reason: 'timeout' })
  })

  it('maps a generic network failure to unavailable with reason network', async () => {
    netFetchMock.mockRejectedValue(new TypeError('fetch failed'))

    const result = await npmRegistryHttpLookup('react')

    expect(result).toEqual({ status: 'unavailable', reason: 'network' })
  })
})
