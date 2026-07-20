import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ensureProxyMock, fetchMock, readAccountMock, readTokenMock } = vi.hoisted(() => ({
  ensureProxyMock: vi.fn(),
  fetchMock: vi.fn(),
  readAccountMock: vi.fn(),
  readTokenMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: fetchMock },
  session: { defaultSession: {} }
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
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('treats credential decryption failures as a disconnected client list', async () => {
    readTokenMock.mockImplementation(() => {
      throw new Error('Could not decrypt credential')
    })
    const { getClients } = await import('./client')

    expect(getClients()).toEqual([])
  })
})
