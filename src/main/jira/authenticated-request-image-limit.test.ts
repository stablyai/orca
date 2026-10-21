import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jiraRequestBinary, type JiraClientForSite } from './authenticated-request'

const { fetchImage } = vi.hoisted(() => ({ fetchImage: vi.fn() }))
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
beforeEach(() => fetchImage.mockReset())

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
  })
  it('returns bounded bytes and forwards caller cancellation to the HTTP client', async () => {
    const controller = new AbortController()
    fetchImage.mockResolvedValue(
      new Response(Uint8Array.from([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    )
    expect(
      await jiraRequestBinary(client, '/image', { maxBytes: 8, signal: controller.signal })
    ).toEqual({ data: Uint8Array.from([1, 2, 3]).buffer, contentType: 'image/png' })
    expect(fetchImage).toHaveBeenCalledWith(
      'https://jira.test/image',
      expect.objectContaining({ signal: controller.signal })
    )
  })
})
