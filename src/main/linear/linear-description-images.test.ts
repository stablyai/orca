import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LinearClientModule from './client'
import { loadLinearSdk } from './linear-sdk'
import { getDescriptionImageUrls } from './linear-description-images'

const { rawRequest, issue, getClients, getPublicFileUrlClient, isAuthError } = vi.hoisted(() => ({
  rawRequest: vi.fn(),
  issue: vi.fn(),
  getClients: vi.fn(),
  getPublicFileUrlClient: vi.fn(),
  isAuthError: vi.fn()
}))

vi.mock('./client', () => ({ getClients, getPublicFileUrlClient, isAuthError }))
vi.mock('./linear-token-store', () => ({ clearToken: vi.fn() }))
vi.mock('./linear-request-concurrency', () => ({ acquire: vi.fn(), release: vi.fn() }))
vi.mock('./linear-issue-query-support', () => ({
  mapRawIssueForWorkspace: (_entry: unknown, result: unknown) => result
}))

const entry = {
  workspace: {
    id: 'workspace-1',
    organizationId: 'workspace-1',
    organizationName: 'Workspace',
    displayName: 'Ada',
    email: null
  },
  apiKey: 'private-key',
  client: new (loadLinearSdk().LinearClient)({ apiKey: 'private-key' })
}
entry.client.client.rawRequest = issue
const source = 'https://uploads.linear.app/w/image'
const signed = `${source}?signature=fresh&expires=123`

describe('Linear description images', () => {
  afterEach(() => vi.restoreAllMocks())

  beforeEach(() => {
    vi.resetAllMocks()
    getClients.mockReturnValue([entry])
    getPublicFileUrlClient.mockReturnValue({ client: { rawRequest } })
  })

  it('sends the signing header through the real SDK transport with the owning workspace token', async () => {
    const clientModule = await vi.importActual<typeof LinearClientModule>('./client')
    getPublicFileUrlClient.mockImplementation(clientModule.getPublicFileUrlClient)
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json({ data: { issue: { description: `![Screenshot](${signed})` } } })
      )

    await expect(
      getDescriptionImageUrls(entry, 'issue-1', `![Screenshot](${source})`)
    ).resolves.toEqual({ [source]: signed })
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'https://api.linear.app/graphql',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: entry.apiKey,
          'public-file-urls-expire-in': '3600'
        })
      })
    )
  })
})
