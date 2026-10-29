import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClickUpRateLimitStateForTests } from './rate-limit'

const { ensureProxyMock, fetchMock, readAccountMock, readTokenMock } = vi.hoisted(() => ({
  ensureProxyMock: vi.fn(),
  fetchMock: vi.fn(),
  readAccountMock: vi.fn(),
  readTokenMock: vi.fn()
}))

vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: ensureProxyMock
}))

vi.mock('./connection-storage', () => ({
  deleteStoredClickUpConnection: vi.fn(),
  getClickUpCredentialError: vi.fn(),
  hasStoredClickUpToken: vi.fn(),
  normalizeClickUpViewer: vi.fn(),
  normalizeClickUpWorkspace: vi.fn(),
  readClickUpAccount: readAccountMock,
  readClickUpToken: readTokenMock,
  saveClickUpToken: vi.fn(),
  writeClickUpAccount: vi.fn()
}))

describe('ClickUp client', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    resetClickUpRateLimitStateForTests()
    // Why the port and not an electron mock: the client fetches through MainHttpClient
    // so it stays bootable on plain Node, which makes an electron net mock inert.
    const { setMainHttpClient } = await import('../network/http-client')
    setMainHttpClient({
      fetch: (url, init) => fetchMock(url, init),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the client never uses the proxy session beyond passing it to the mocked proxy setup.
      proxySession: () => ({}) as never
    })
    ensureProxyMock.mockResolvedValue(undefined)
    readAccountMock.mockReturnValue({
      version: 1,
      viewer: { id: 7, username: 'Ada' },
      workspaces: [{ id: 'team-1', name: 'Engineering' }],
      activeWorkspaceId: 'team-1',
      selectedWorkspaceId: 'team-1'
    })
    readTokenMock.mockReturnValue('pk_token')
  })

  it('bounds API requests with an abort signal', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const { clickUpRequest } = await import('./client')

    await clickUpRequest(
      { workspace: { id: 'team-1', name: 'Engineering' }, token: 'pk_token' },
      '/user'
    )

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.clickup.com/api/v2/user',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it("retries a rate-limited request after ClickUp's Retry-After", async () => {
    vi.useFakeTimers()
    try {
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ err: 'Rate limit reached' }), {
            status: 429,
            headers: { 'Retry-After': '1' }
          })
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: 7 } }), { status: 200 }))
      const { clickUpRequest } = await import('./client')

      const pending = clickUpRequest<{ user: { id: number } }>(
        { workspace: { id: 'team-1', name: 'Engineering' }, token: 'pk_token' },
        '/user'
      )
      await vi.advanceTimersByTimeAsync(1_000)

      await expect(pending).resolves.toEqual({ user: { id: 7 } })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares one request between identical concurrent reads', async () => {
    let resolveFetch: (value: Response) => void = () => undefined
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve
      })
    )
    const { clickUpRequest } = await import('./client')
    const client = { workspace: { id: 'team-1', name: 'Engineering' }, token: 'pk_token' }

    const first = clickUpRequest(client, '/team/team-1/space')
    const second = clickUpRequest(client, '/team/team-1/space')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    resolveFetch(new Response(JSON.stringify({ spaces: [] }), { status: 200 }))

    await expect(Promise.all([first, second])).resolves.toEqual([{ spaces: [] }, { spaces: [] }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats credential decryption failures as a disconnected client list', async () => {
    readTokenMock.mockImplementation(() => {
      throw new Error('Could not decrypt credential')
    })
    const { getClients } = await import('./client')

    expect(getClients()).toEqual([])
  })
})
