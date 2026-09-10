import type { Session } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { electronHttpClient } from '../host/electron-http-client'
import { getMainHttpClient, setMainHttpClient } from '../network/http-client'
import { installElectronProxyRequestGuard } from '../network/electron-proxy-request-guard'
import {
  applyProxySettingsToSession,
  resetSessionProxyApplicationForTests
} from '../network/proxy-settings'
import { acquireIssueListPage, LIST_ISSUES_QUERY } from './mcp-issue-list-acquisition'

const electron = vi.hoisted(() => ({
  net: { fetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>() },
  session: { defaultSession: {} }
}))
vi.mock('electron', () => electron)

const variables = { first: 1, after: 'synthetic-cursor' }
const options = { apiKey: 'synthetic', apiUrl: 'https://fixture.invalid/graphql' }
const emptyPage = { nodes: [], pageInfo: { hasNextPage: false } }

function installDesktopTransport(response: Response) {
  let beforeRequest!: (details: unknown, callback: (result: { cancel?: boolean }) => void) => void
  const proxySession = {
    resolveProxy: vi.fn(async () => 'DIRECT'),
    setProxy: vi.fn(async () => {}),
    closeAllConnections: vi.fn(async () => {}),
    webRequest: {
      onBeforeRequest: vi.fn((listener: typeof beforeRequest) => (beforeRequest = listener))
    }
  }
  electron.session.defaultSession = proxySession
  resetSessionProxyApplicationForTests(proxySession)
  installElectronProxyRequestGuard(proxySession as unknown as Session)
  setMainHttpClient(electronHttpClient)
  const delivered = vi.fn()
  // Model Chromium's default-session dispatch; production guard and policy remain real.
  electron.net.fetch.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        beforeRequest({}, (result) => {
          if (result.cancel) {
            reject(new Error('request cancelled by proxy guard'))
          } else {
            delivered()
            resolve(response)
          }
        })
      })
  )
  return { proxySession, delivered }
}

beforeEach(() => {
  electron.net.fetch.mockReset()
})
afterEach(() => {
  setMainHttpClient(null)
  vi.unstubAllGlobals()
})

describe('Linear acquisition HTTP owner', () => {
  it('routes through the desktop owner and waits for default-session proxy application', async () => {
    const response = Response.json({ data: { issues: emptyPage } })
    const { proxySession, delivered } = installDesktopTransport(response)
    const globalFetch = vi.fn()
    vi.stubGlobal('fetch', globalFetch)
    let finishWrite!: () => void
    proxySession.setProxy.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishWrite = resolve))
    )
    const applying = applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'http://proxy.example:8080' },
      { env: {} }
    )
    const signal = new AbortController().signal
    const acquiring = acquireIssueListPage(options, variables, signal)
    await vi.waitFor(() => expect(proxySession.setProxy).toHaveBeenCalledOnce())
    expect(electron.net.fetch).toHaveBeenCalledExactlyOnceWith(options.apiUrl, {
      method: 'POST',
      headers: expect.any(Headers),
      body: JSON.stringify({ query: LIST_ISSUES_QUERY, variables }),
      signal
    })
    expect(getMainHttpClient().proxySession()).toBe(proxySession)
    expect(delivered).not.toHaveBeenCalled()
    expect(globalFetch).not.toHaveBeenCalled()
    finishWrite()
    await applying
    await expect(acquiring).resolves.toEqual(emptyPage)
    expect(delivered).toHaveBeenCalledOnce()
    expect(response.bodyUsed).toBe(true)
  })

  it('refuses acquisition when default-session proxy application fails', async () => {
    const { proxySession, delivered } = installDesktopTransport(
      Response.json({ data: { issues: emptyPage } })
    )
    proxySession.setProxy.mockRejectedValue(new Error('synthetic proxy failure'))
    await expect(
      applyProxySettingsToSession(
        proxySession,
        { httpProxyUrl: 'http://proxy.example:8080' },
        { env: {} }
      )
    ).rejects.toThrow('synthetic proxy failure')
    await expect(
      acquireIssueListPage(options, variables, new AbortController().signal)
    ).rejects.toThrow('request cancelled by proxy guard')
    expect(electron.net.fetch).toHaveBeenCalledOnce()
    expect(delivered).not.toHaveBeenCalled()
  })

  it.each(['desktop', 'node'])('cancels an unread error body on the %s owner', async (host) => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), {
      status: 429,
      headers: { 'retry-after': '2' }
    })
    if (host === 'desktop') {
      installDesktopTransport(response)
    } else {
      setMainHttpClient(null)
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => response)
      )
      expect(getMainHttpClient().proxySession()).toBeNull()
    }
    await expect(
      acquireIssueListPage(options, variables, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'linear_rate_limited' })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
