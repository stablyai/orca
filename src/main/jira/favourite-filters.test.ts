import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'
import type * as JiraAuthenticatedRequestModule from './authenticated-request'
import { JiraApiError } from './jira-api-error'

const mocks = vi.hoisted(() => ({
  getClients: vi.fn(),
  clearToken: vi.fn(),
  jiraRequest: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn()
}))
vi.mock('./client', () => ({
  getClients: mocks.getClients,
  clearToken: mocks.clearToken
}))
vi.mock('./authenticated-request', async (importOriginal) => ({
  ...(await importOriginal<typeof JiraAuthenticatedRequestModule>()),
  jiraRequest: mocks.jiraRequest
}))
vi.mock('./request-queue', () => ({ acquire: mocks.acquire, release: mocks.release }))

import { listFavouriteFilters } from './favourite-filters'

function entry(id: string, authType: 'cloud' | 'server' = 'cloud'): JiraClientForSite {
  return {
    site: {
      id,
      siteUrl: 'https://jira.example.com',
      email: '',
      displayName: id,
      accountId: 'me',
      authType
    },
    authorization: authType === 'cloud' ? 'Basic cloud-token' : 'Bearer server-token'
  }
}
const filter = { id: '1', name: 'Mine', jql: 'assignee = currentUser()' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.acquire.mockResolvedValue(undefined)
  mocks.getClients.mockReturnValue([entry('site-1')])
  mocks.jiraRequest.mockResolvedValue([filter])
})

describe('read-only Jira favourite filters', () => {
  it.each(['cloud', 'server'] as const)(
    'uses one official %s endpoint and that site authorization',
    async (authType) => {
      const client = entry('site-1', authType)
      mocks.getClients.mockReturnValue([client])
      const result = await listFavouriteFilters(' site-1 ')
      expect(result).toEqual({ filters: [{ ...filter, siteId: 'site-1' }], truncated: false })
      expect(mocks.getClients).toHaveBeenCalledExactlyOnceWith('site-1')
      expect(mocks.jiraRequest).toHaveBeenCalledExactlyOnceWith(
        client,
        `/rest/api/${authType === 'cloud' ? '3' : '2'}/filter/favourite?expand=jql`,
        { signal: expect.any(AbortSignal) },
        2 * 1024 * 1024
      )
      expect(mocks.acquire).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal))
      expect(mocks.release).toHaveBeenCalledOnce()
    }
  )

  it.each([undefined, null, '', ' ', 'all', ' all ', 'x'.repeat(129)])(
    'rejects invalid site %j before reading credentials',
    async (siteId) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Invalid external input deliberately exercises the backend boundary.
      await expect(listFavouriteFilters(siteId as string)).rejects.toThrow()
      expect(mocks.getClients).not.toHaveBeenCalled()
      expect(mocks.jiraRequest).not.toHaveBeenCalled()
    }
  )

  it.each([
    { clients: [] },
    { clients: [entry('other-site')] },
    { clients: [entry('site-1'), entry('other-site')] }
  ])('refuses missing or mismatched client selection', async ({ clients }) => {
    mocks.getClients.mockReturnValue(clients)
    await expect(listFavouriteFilters('site-1')).rejects.toThrow('one connected site')
    expect(mocks.jiraRequest).not.toHaveBeenCalled()
    expect(mocks.acquire).not.toHaveBeenCalled()
  })

  it.each([
    new JiraApiError('expired', 401),
    new JiraApiError('forbidden', 403),
    new JiraApiError('scope mismatch', 401, true),
    new Error('network failed')
  ])('preserves %s without mutating credentials', async (error) => {
    mocks.jiraRequest.mockRejectedValueOnce(error)
    await expect(listFavouriteFilters('site-1')).rejects.toBe(error)
    expect(mocks.clearToken).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('surfaces malformed payloads without clearing credentials or fetching each filter', async () => {
    mocks.jiraRequest.mockResolvedValueOnce({ values: [filter] })
    await expect(listFavouriteFilters('site-1')).rejects.toThrow('invalid favourite filter list')
    expect(mocks.clearToken).not.toHaveBeenCalled()
    expect(mocks.jiraRequest).toHaveBeenCalledOnce()
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('propagates cancellation while queued without releasing an unacquired slot', async () => {
    const controller = new AbortController()
    controller.abort()
    const error = new DOMException('aborted', 'AbortError')
    mocks.acquire.mockRejectedValueOnce(error)
    await expect(listFavouriteFilters('site-1', controller.signal)).rejects.toBe(error)
    expect(mocks.acquire.mock.calls[0]?.[0].aborted).toBe(true)
    expect(mocks.jiraRequest).not.toHaveBeenCalled()
    expect(mocks.release).not.toHaveBeenCalled()
  })

  it('aborts an active request without clearing credentials', async () => {
    const controller = new AbortController()
    mocks.jiraRequest.mockImplementationOnce(async (_client, _path, init) => {
      controller.abort()
      expect(init.signal.aborted).toBe(true)
      throw new JiraApiError('aborted with stale response', 401)
    })
    await expect(listFavouriteFilters('site-1', controller.signal)).rejects.toThrow('aborted')
    expect(mocks.clearToken).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledOnce()
  })
})
