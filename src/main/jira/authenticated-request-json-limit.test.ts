import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jiraRequest, type JiraClientForSite } from './authenticated-request'

const { fetchJson } = vi.hoisted(() => ({ fetchJson: vi.fn() }))
vi.mock('../network/http-client', () => ({
  getMainHttpClient: () => ({ fetch: fetchJson, proxySession: () => null })
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
  authorization: 'Bearer fixture-token'
}
beforeEach(() => fetchJson.mockReset())

describe('opt-in bounded Jira JSON responses', () => {
  it('rejects oversized declared bodies before high-level JSON parsing', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': '9' }
    })
    const json = vi.spyOn(response, 'json')
    fetchJson.mockResolvedValue(response)
    await expect(jiraRequest(client, '/filters', undefined, 8)).rejects.toThrow('byte limit')
    expect(cancel).toHaveBeenCalledOnce()
    expect(json).not.toHaveBeenCalled()
  })

  it('cancels streaming bodies exceeding the cap without Content-Length', async () => {
    let parts = 0
    const cancel = vi.fn()
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          parts += 1
          controller.enqueue(new TextEncoder().encode('123'))
        },
        cancel
      })
    )
    const json = vi.spyOn(response, 'json')
    fetchJson.mockResolvedValue(response)
    await expect(jiraRequest(client, '/filters', undefined, 8)).rejects.toThrow('byte limit')
    expect(cancel).toHaveBeenCalledOnce()
    expect(json).not.toHaveBeenCalled()
    expect(parts).toBeLessThanOrEqual(4)
  })

  it('decodes bounded JSON and keeps gateway credentials, redirects and cancellation', async () => {
    const gatewayClient: JiraClientForSite = {
      ...client,
      site: { ...client.site, apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-abc' }
    }
    const signal = new AbortController().signal
    fetchJson.mockResolvedValue(new Response(JSON.stringify({ value: 'é' })))
    expect(await jiraRequest(gatewayClient, '/filters', { signal }, 32)).toEqual({ value: 'é' })
    expect(fetchJson).toHaveBeenCalledWith(
      'https://api.atlassian.com/ex/jira/cloud-abc/filters',
      expect.objectContaining({ signal, redirect: 'error' })
    )
    const headers = fetchJson.mock.calls[0]?.[1]?.headers
    expect(headers).toBeInstanceOf(Headers)
    expect(headers.get('Authorization')).toBe('Bearer fixture-token')
  })

  it('leaves existing callers on their original response reader', async () => {
    const response = new Response('[1,2,3]')
    const json = vi.spyOn(response, 'json')
    fetchJson.mockResolvedValue(response)
    expect(await jiraRequest(client, '/legacy')).toEqual([1, 2, 3])
    expect(json).toHaveBeenCalledOnce()
  })

  it.each([401, 403, 500])('also bounds error bodies while retaining HTTP %s', async (status) => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), {
      status,
      statusText: 'Jira request failed',
      headers: { 'content-length': '9' }
    })
    const json = vi.spyOn(response, 'json')
    fetchJson.mockResolvedValue(response)
    await expect(jiraRequest(client, '/filters', undefined, 8)).rejects.toMatchObject({
      status,
      message: 'Jira request failed'
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(json).not.toHaveBeenCalled()
  })

  it('preserves bounded Jira error details and token scope detection', async () => {
    fetchJson.mockResolvedValue(
      new Response(JSON.stringify({ message: 'scope does not match' }), { status: 401 })
    )
    const gatewayClient: JiraClientForSite = {
      ...client,
      site: { ...client.site, apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-abc' }
    }
    await expect(jiraRequest(gatewayClient, '/filters', undefined, 256)).rejects.toMatchObject({
      status: 401,
      scopeMismatch: true,
      message: expect.stringContaining('API token scopes')
    })
  })
})
