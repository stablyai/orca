import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectKaneo, getKaneoTask } from './client'
import { getKaneoStatus, readKaneoCredential, saveKaneoCredential } from './credential-store'
import { setMainHttpClient } from '../network/http-client'

vi.mock('./credential-store', () => ({
  getKaneoStatus: vi.fn(),
  readKaneoCredential: vi.fn(),
  saveKaneoCredential: vi.fn()
}))
const siteUrl = 'https://tasks.example.com'
const url = `${siteUrl}/dashboard/workspace/ws/project/proj/task/task`
const fetchMock = vi.fn<typeof fetch>()
const task = {
  id: 'task',
  projectId: 'proj',
  title: 'Fix booking',
  description: '**Details**',
  number: 42,
  status: 'todo'
}
const project = { id: 'proj', workspaceId: 'ws' }

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(getKaneoStatus).mockReturnValue({ connected: true, siteUrl })
  vi.mocked(readKaneoCredential).mockReturnValue({ siteUrl, apiKey: 'test-secret' })
  fetchMock.mockImplementation(async (input) =>
    Response.json(String(input).includes('/task/') ? task : [project])
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  setMainHttpClient(null)
})

describe('Kaneo task lookup', () => {
  it('uses the host HTTP client so desktop requests follow the configured proxy', async () => {
    const desktopFetch = vi.fn(async () => Response.json([]))
    setMainHttpClient({ fetch: desktopFetch, proxySession: () => null })
    await connectKaneo({ siteUrl, apiKey: 'test-secret' })
    expect(desktopFetch).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns a validated task and sends bearer credentials only to the configured origin', async () => {
    expect(await getKaneoTask(url)).toMatchObject({
      title: task.title,
      description: task.description,
      url,
      number: 42
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [input, init] of fetchMock.mock.calls) {
      expect(String(input).startsWith(`${siteUrl}/api/`)).toBe(true)
      expect(init).toMatchObject({
        headers: { Authorization: 'Bearer test-secret' },
        redirect: 'error'
      })
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('does not decrypt or send credentials for another instance or an invalid URL', async () => {
    await expect(getKaneoTask(url.replace(siteUrl, 'https://attacker.example'))).rejects.toThrow(
      'different Kaneo instance'
    )
    await expect(getKaneoTask('https://tasks.example.com/not-a-task')).rejects.toThrow(
      'valid Kaneo task URL'
    )
    expect(readKaneoCredential).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not trust display metadata to bind a token to an origin', async () => {
    vi.mocked(readKaneoCredential).mockReturnValue({
      siteUrl: 'https://other.example',
      apiKey: 'other-key'
    })
    await expect(getKaneoTask(url)).rejects.toThrow('Reconnect')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([401, 403, 404, 429, 500])(
    'reports HTTP %s without leaking the response body or token',
    async (status) => {
      fetchMock.mockResolvedValue(new Response('private server data test-secret', { status }))
      await expect(getKaneoTask(url)).rejects.toThrow(/Kaneo|access/)
      await expect(getKaneoTask(url)).rejects.not.toThrow(/private server data|test-secret/)
    }
  )

  it('rejects a task belonging to a different project or workspace', async () => {
    fetchMock.mockImplementation(async (input) =>
      Response.json(
        String(input).includes('/task/') ? task : [{ ...project, workspaceId: 'other' }]
      )
    )
    await expect(getKaneoTask(url)).rejects.toThrow('does not match')
  })

  it('does not expose response contents when successful HTTP responses contain invalid JSON', async () => {
    fetchMock.mockImplementation(async () => new Response('private server data test-secret'))
    await expect(getKaneoTask(url)).rejects.toThrow('Kaneo returned an invalid JSON response.')
    await expect(connectKaneo({ siteUrl, apiKey: 'test-secret' })).rejects.toThrow(
      'Kaneo returned an invalid JSON response.'
    )
    expect(saveKaneoCredential).not.toHaveBeenCalled()
  })

  it('bounds streamed responses and cancels an oversized body', async () => {
    const cancel = vi.fn()
    fetchMock.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(512 * 1024 + 1))
            },
            cancel
          })
        )
    )
    await expect(getKaneoTask(url)).rejects.toThrow('size limit')
    expect(cancel).toHaveBeenCalled()
  })

  it('propagates in-flight cancellation to both pending requests', async () => {
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true
          })
        })
    )
    const controller = new AbortController()
    const lookup = getKaneoTask(url, controller.signal)
    const rejected = expect(lookup).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every(([, init]) => !init!.signal!.aborted)).toBe(true)
    controller.abort()
    await rejected
    expect(fetchMock.mock.calls.every(([, init]) => init!.signal!.aborted)).toBe(true)
  })

  it.each(['task', 'project'])('aborts the companion when the %s request fails', async (failed) => {
    const cancelled = vi.fn()
    fetchMock.mockImplementation(async (input, init) => {
      const kind = String(input).includes('/task/') ? 'task' : 'project'
      if (kind === failed) {
        return new Response('', { status: 429 })
      }
      return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener(
          'abort',
          () => {
            cancelled()
            reject(init!.signal!.reason)
          },
          { once: true }
        )
      })
    })
    await expect(getKaneoTask(url)).rejects.toThrow('rate limiting')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('verifies a connection before storing it and keeps existing credentials on failure', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([]))
    await connectKaneo({ siteUrl: `${siteUrl}/`, apiKey: ' test-secret ' })
    expect(fetchMock.mock.calls[0][0]).toBe(`${siteUrl}/api/auth/organization/list`)
    expect(saveKaneoCredential).toHaveBeenCalledWith({ siteUrl, apiKey: 'test-secret' })
    vi.mocked(saveKaneoCredential).mockClear()
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }))
    await expect(connectKaneo({ siteUrl, apiKey: 'invalid' })).rejects.toThrow()
    expect(saveKaneoCredential).not.toHaveBeenCalled()
  })
})
