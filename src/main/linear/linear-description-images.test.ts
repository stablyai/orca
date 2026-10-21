import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LinearClientModule from './client'
import { loadLinearSdk } from './linear-sdk'
import { getDescriptionImageUrls } from './linear-description-images'
import { getIssue } from './linear-issue-lookups'

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
  mapIssueForWorkspace: async (_entry: unknown, result: unknown) => result
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
entry.client.issue = issue
const source = 'https://uploads.linear.app/w/image'
const signed = `${source}?signature=fresh&expires=123`

describe('Linear description images', () => {
  afterEach(() => vi.restoreAllMocks())

  beforeEach(() => {
    vi.resetAllMocks()
    getClients.mockReturnValue([entry])
    getPublicFileUrlClient.mockReturnValue({ client: { rawRequest } })
  })

  it('keeps editable description URLs canonical while supplying signed display URLs', async () => {
    const description = `Before\n\n![Screenshot](${source})\n\nAfter`
    issue.mockResolvedValue({ id: 'issue-1', description })
    rawRequest.mockResolvedValue({
      data: { issue: { description: description.replace(source, signed) } }
    })

    await expect(getIssue('issue-1', 'workspace-1')).resolves.toEqual({
      id: 'issue-1',
      description,
      descriptionImageUrls: { [source]: signed }
    })
    expect(getPublicFileUrlClient).toHaveBeenCalledWith(entry, expect.any(AbortSignal))
    expect(rawRequest.mock.calls[0][1]).toEqual({ id: 'issue-1' })
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
          'public-file-urls-expire-in': String(clientModule.LINEAR_PUBLIC_FILE_URL_EXPIRY_SECONDS)
        })
      })
    )
  })

  it.each([undefined, 'No images', '![Public](https://example.com/image.png)'])(
    'skips the extra read for descriptions without private uploads: %s',
    async (description) => {
      issue.mockResolvedValue({ id: 'issue-1', description })
      await expect(getIssue('issue-1')).resolves.toEqual({ id: 'issue-1', description })
      expect(getPublicFileUrlClient).not.toHaveBeenCalled()
    }
  )

  it('matches reordered media by path and preserves the original query parameters', async () => {
    const original = `${source}?width=640`
    rawRequest.mockResolvedValue({
      data: {
        issue: {
          description: `![Other](https://uploads.linear.app/w/other?signature=other)\n![Screenshot](${signed})`
        }
      }
    })
    await expect(
      getDescriptionImageUrls(entry, 'issue-1', `![Screenshot](${original})`)
    ).resolves.toEqual({ [original]: signed })
  })

  it('keeps the issue readable when the signing read fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    issue.mockResolvedValue({ id: 'issue-1', description: `![Screenshot](${source})` })
    rawRequest.mockRejectedValue(new Error('Network unavailable'))
    await expect(getIssue('issue-1')).resolves.toMatchObject({ id: 'issue-1' })
  })

  it('propagates authentication failures for credential recovery', async () => {
    const error = new Error('Unauthorized')
    isAuthError.mockReturnValue(true)
    rawRequest.mockRejectedValue(error)
    await expect(
      getDescriptionImageUrls(entry, 'issue-1', `![Screenshot](${source})`)
    ).rejects.toBe(error)
  })
})
