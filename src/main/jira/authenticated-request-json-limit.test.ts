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
})
