import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  classifyRedmineError,
  normalizeRedmineUrl,
  RedmineApiError,
  redmineRequest
} from './redmine-request'

const { httpFetch } = vi.hoisted(() => ({ httpFetch: vi.fn() }))

vi.mock('../network/http-client', () => ({
  getMainHttpClient: vi.fn(() => ({
    proxySession: () => null,
    fetch: (...args: unknown[]) => httpFetch(...args)
  }))
}))
vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../observability/tracer', () => ({
  withSpan: (
    name: string,
    fn: (span: { setAttribute: () => void; addEvent: () => void }) => unknown
  ) => {
    void name
    return fn({ setAttribute() {}, addEvent() {} })
  }
}))

beforeEach(() => {
  httpFetch.mockReset()
})

function stubResponse({ status, location }: { status: number; location?: string }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'stub',
    headers: { get: (key: string) => (key === 'location' ? (location ?? null) : null) },
    json: async () => ({})
  }
}

describe('normalizeRedmineUrl', () => {
  it('auto-prepends https for a schema-less host (matches Jira behavior)', () => {
    expect(normalizeRedmineUrl('redmine.example.com')).toBe('https://redmine.example.com')
    expect(normalizeRedmineUrl('redmine.example.com/')).toBe('https://redmine.example.com')
  })

  it('allows https hosts and trims a trailing slash', () => {
    expect(normalizeRedmineUrl('https://redmine.example.com/')).toBe('https://redmine.example.com')
  })

  it('allows http on loopback hosts', () => {
    expect(normalizeRedmineUrl('http://127.0.0.1:9080')).toBe('http://127.0.0.1:9080')
    expect(normalizeRedmineUrl('http://localhost:3000/')).toBe('http://localhost:3000')
    expect(normalizeRedmineUrl('http://[::1]:8080')).toBe('http://[::1]:8080')
  })

  it('rejects http on a non-loopback host (API key travels cleartext)', () => {
    expect(() => normalizeRedmineUrl('http://redmine.example.com')).toThrow(RedmineApiError)
    expect(() => normalizeRedmineUrl('http://redmine.internal')).toThrow(RedmineApiError)
  })

  it('classifies the rejection as an unknown read error', () => {
    try {
      normalizeRedmineUrl('http://redmine.example.com')
    } catch (error) {
      const classified = classifyRedmineError(error)
      expect(classified.type).toBe('unknown')
      expect(classified.message).toMatch(/HTTPS/)
    }
  })
})

describe('redmineRequest redirect guard', () => {
  it('rejects a redirect to a cleartext http host before sending the API key', async () => {
    httpFetch.mockResolvedValueOnce(
      stubResponse({ status: 302, location: 'http://evil.example.com' })
    )
    await expect(
      redmineRequest('https://good.example.com', 'api-key', '/issues.json')
    ).rejects.toThrow(RedmineApiError)
    // Never issued a second hop to the cleartext target.
    expect(httpFetch).toHaveBeenCalledTimes(1)
  })

  it('follows a redirect to an https target', async () => {
    httpFetch
      .mockResolvedValueOnce(
        stubResponse({ status: 302, location: 'https://good.example.com/relocated' })
      )
      .mockResolvedValueOnce(stubResponse({ status: 200 }))
    await expect(redmineRequest('https://good.example.com', 'k', '/issues.json')).resolves.toEqual(
      {}
    )
    expect(httpFetch).toHaveBeenCalledTimes(2)
  })

  it('rejects a cross-origin https redirect before forwarding the API key', async () => {
    httpFetch.mockResolvedValueOnce(
      stubResponse({ status: 302, location: 'https://evil.example.com/steal' })
    )
    await expect(redmineRequest('https://good.example.com', 'k', '/issues.json')).rejects.toThrow(
      RedmineApiError
    )
    // Never forwarded the key to the other origin.
    expect(httpFetch).toHaveBeenCalledTimes(1)
  })
})

describe('classifyRedmineError', () => {
  it('classifies 401/403 as auth', () => {
    expect(classifyRedmineError(new RedmineApiError('denied', 401)).type).toBe('auth')
  })

  it('classifies 404 as not_found', () => {
    expect(classifyRedmineError(new RedmineApiError('missing', 404)).type).toBe('not_found')
  })

  it('classifies aborts as network', () => {
    expect(classifyRedmineError(new DOMException('aborted', 'AbortError')).type).toBe('network')
  })
})
