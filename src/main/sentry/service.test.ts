import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  readConnection: vi.fn(),
  readToken: vi.fn()
}))

vi.mock('./api-client', () => ({
  normalizeSentryBaseUrl: (value: string) => value,
  parseSentryPagination: () => ({ nextCursor: null, previousCursor: null }),
  sentryRequest: mocks.request
}))

vi.mock('./credential-store', () => ({
  clearSentryCredential: vi.fn(),
  readSentryConnectionFile: mocks.readConnection,
  readSentryToken: mocks.readToken,
  saveSentryCredential: vi.fn()
}))

import { getSentryIssue, listSentryEvents, listSentryIssues, updateSentryIssue } from './service'

const HEADERS = new Headers()
const ISSUE = {
  id: '42',
  shortId: 'APP-42',
  title: 'Failure',
  permalink: 'https://sentry.example/issues/42/',
  project: { id: '7', slug: 'app', name: 'App' }
}

beforeEach(() => {
  mocks.request.mockReset()
  mocks.readConnection.mockReturnValue({
    baseUrl: 'https://sentry.example',
    organization: { id: '1', slug: 'acme', name: 'Acme' },
    organizations: [{ id: '1', slug: 'acme', name: 'Acme' }]
  })
  mocks.readToken.mockReturnValue('token')
})

describe('Sentry issue routes', () => {
  it('uses the organization route for issue search', async () => {
    mocks.request.mockResolvedValue({ value: [ISSUE], headers: HEADERS })

    await listSentryIssues({})

    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/0/organizations/acme/issues/' })
    )
  })

  it('uses global issue routes for detail, events, and updates', async () => {
    mocks.request
      .mockResolvedValueOnce({ value: ISSUE, headers: HEADERS })
      .mockResolvedValueOnce({ value: [], headers: HEADERS })
      .mockResolvedValueOnce({ value: ISSUE, headers: HEADERS })

    await getSentryIssue('42')
    await listSentryEvents('42')
    await updateSentryIssue('42', { status: 'resolved' })

    expect(mocks.request.mock.calls.map(([request]) => request.path)).toEqual([
      '/api/0/issues/42/',
      '/api/0/issues/42/events/',
      '/api/0/issues/42/'
    ])
  })
})
