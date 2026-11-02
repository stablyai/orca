import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JiraApiError } from './authenticated-request'

const { getClients, jiraRequest, clearToken, release } = vi.hoisted(() => ({
  getClients: vi.fn(),
  jiraRequest: vi.fn(),
  clearToken: vi.fn(),
  release: vi.fn()
}))
vi.mock('./request-queue', () => ({ acquire: vi.fn(), release }))
vi.mock('./client', () => ({
  getClients,
  clearToken,
  isAuthError: (error: unknown) => error instanceof JiraApiError && error.status === 401
}))
vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  jiraRequest,
  JiraApiError: class extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message)
    }
  }
}))
const entry = {
  site: { id: 'site-1', siteUrl: 'https://jira.example.com' },
  authorization: 'token'
}
const transition = {
  id: '31',
  name: 'Close',
  to: { id: '3', name: 'Done' },
  fields: {
    resolution: {
      required: true,
      name: 'Resolution',
      schema: { type: 'resolution' },
      allowedValues: [{ id: '1', name: 'Fixed' }]
    }
  }
}

describe('required Jira transition fields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    jiraRequest.mockReset()
    getClients.mockReturnValue([entry])
  })

  it('loads required resolution metadata rather than hiding it from the form', async () => {
    jiraRequest.mockResolvedValue({ transitions: [transition] })
    const { listTransitions } = await import('./jira-transition-queries')
    expect(await listTransitions('APP-1', 'site-1')).toMatchObject([
      {
        id: '31',
        fields: [{ key: 'resolution', required: true, allowedValues: [{ id: '1', name: 'Fixed' }] }]
      }
    ])
    expect(jiraRequest).toHaveBeenCalledWith(
      entry,
      '/rest/api/3/issue/APP-1/transitions?expand=transitions.fields'
    )
  })

  it('posts resolution and comment in the same request Jira validates', async () => {
    jiraRequest.mockImplementation(async (_entry, _path, options) => {
      const payload = JSON.parse(options.body)
      if (!payload.fields?.resolution || !payload.update?.comment) {
        throw new JiraApiError('Resolution and Comment are required.', 400)
      }
      return undefined
    })
    const { updateIssue } = await import('./jira-issue-mutations')
    const updates = {
      transitionId: '31',
      transitionFields: { resolution: { id: '1' } },
      transitionComment: 'Verified fix'
    }
    expect(await updateIssue('APP-1', updates, 'site-1')).toEqual({ ok: true })
    const payload = JSON.parse(jiraRequest.mock.calls[0]?.[2].body)
    expect(payload).toMatchObject({
      transition: { id: '31' },
      fields: { resolution: { id: '1' } },
      update: { comment: [{ add: { body: { type: 'doc', version: 1 } } }] }
    })
  })

  it('falls back to a bare list when field expansion is unavailable', async () => {
    jiraRequest
      .mockRejectedValueOnce(new JiraApiError('Unsupported expand', 400))
      .mockResolvedValueOnce({ transitions: [transition] })
    const { listTransitions } = await import('./jira-transition-queries')
    expect(await listTransitions('APP-1')).toMatchObject([{ id: '31' }])
    expect(jiraRequest.mock.calls[1]?.[1]).toBe('/rest/api/3/issue/APP-1/transitions')
  })

  it('surfaces operational list failures and releases the queue', async () => {
    jiraRequest.mockRejectedValue(new JiraApiError('Service unavailable', 503))
    const { listTransitions } = await import('./jira-transition-queries')
    await expect(listTransitions('APP-1', 'site-1', true)).rejects.toThrow('Service unavailable')
    expect(jiraRequest).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledOnce()
    expect(clearToken).not.toHaveBeenCalled()
  })

  it('preserves the legacy empty list on operational failures without strict reads', async () => {
    jiraRequest.mockRejectedValue(new JiraApiError('Service unavailable', 503))
    const { listTransitions } = await import('./jira-transition-queries')
    expect(await listTransitions('APP-1', 'site-1')).toEqual([])
    expect(jiraRequest).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledOnce()
    expect(clearToken).not.toHaveBeenCalled()
  })

  it('does not retry expired credentials', async () => {
    jiraRequest.mockRejectedValue(new JiraApiError('Unauthorized', 401))
    const { listTransitions } = await import('./jira-transition-queries')
    await expect(listTransitions('APP-1')).rejects.toThrow('Unauthorized')
    expect(jiraRequest).toHaveBeenCalledTimes(1)
    expect(clearToken).toHaveBeenCalledWith('site-1')
  })

  it('keeps old-client bare transitions and Server comments compatible', async () => {
    jiraRequest.mockResolvedValue(undefined)
    const { updateIssue } = await import('./jira-issue-mutations')
    await updateIssue('APP-1', { transitionId: '11' })
    expect(JSON.parse(jiraRequest.mock.calls[0]?.[2].body)).toEqual({ transition: { id: '11' } })
    getClients.mockReturnValue([{ ...entry, site: { ...entry.site, authType: 'server' } }])
    const updates = { transitionId: '31', transitionComment: 'Verified fix' }
    await updateIssue('APP-1', updates)
    expect(JSON.parse(jiraRequest.mock.calls[1]?.[2].body)).toMatchObject({
      update: { comment: [{ add: { body: 'Verified fix' } }] }
    })
  })
})
