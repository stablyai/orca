import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectKaneo, getKaneoTask } from './client'
import { getKaneoStatus, readKaneoCredential, saveKaneoCredential } from './credential-store'

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
afterEach(() => vi.unstubAllGlobals())

describe('Kaneo task lookup', () => {
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

  it('propagates cancellation to both requests', async () => {
    const controller = new AbortController()
    await getKaneoTask(url, controller.signal)
    controller.abort()
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal?.aborted).toBe(true)
    }
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
