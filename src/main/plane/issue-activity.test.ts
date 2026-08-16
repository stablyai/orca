import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaneClientForInstance } from './client'

const planeFetch = vi.fn()
const getClient = vi.fn()
const getClients = vi.fn()

vi.mock('./client', () => ({
  getClient: (...args: unknown[]) => getClient(...args),
  getClients: (...args: unknown[]) => getClients(...args)
}))

vi.mock('./api-request', () => ({
  apiPath: (client: PlaneClientForInstance, suffix: string) =>
    `/api/v1/workspaces/${client.instance.workspaceSlug}${suffix}`,
  planeFetch: (...args: unknown[]) => planeFetch(...args),
  planeWebUrl: (_client: PlaneClientForInstance, identifier: string) =>
    `https://plane.example/acme/issues/${identifier}`
}))

function client(): PlaneClientForInstance {
  return {
    auth: { kind: 'apiKey', apiKey: 'token' },
    instance: {
      id: 'https://plane.example::acme',
      baseUrl: 'https://plane.example',
      workspaceSlug: 'acme',
      displayName: 'Ada',
      email: 'ada@example.com',
      userId: 'user-1'
    }
  }
}

function issue() {
  return {
    id: 'issue-1',
    name: 'Issue 1',
    sequence_id: 1,
    project: { id: 'project-1', name: 'Project', identifier: 'AIF' }
  }
}

describe('Plane issue activity', () => {
  beforeEach(() => {
    planeFetch.mockReset()
    getClient.mockReset()
    getClients.mockReset()
    getClient.mockReturnValue(client())
    getClients.mockReturnValue([client()])
  })

  it('lists and creates work item links and lists attachment metadata', async () => {
    planeFetch
      .mockResolvedValueOnce(issue())
      .mockResolvedValueOnce({
        results: [{ id: 'link-1', title: 'Spec', url: 'https://example.com' }]
      })
      .mockResolvedValueOnce(issue())
      .mockResolvedValueOnce({ id: 'link-2', title: 'PR', url: 'https://example.com/pr' })
      .mockResolvedValueOnce(issue())
      .mockResolvedValueOnce({ results: [{ id: 'asset-1', file_name: 'trace.txt', size: 42 }] })
    const { issueLinks, addIssueLink, issueAttachments } = await import('./issue-activity')

    await expect(issueLinks('AIF-1')).resolves.toMatchObject([{ id: 'link-1' }])
    await expect(addIssueLink('AIF-1', 'PR', 'https://example.com/pr')).resolves.toEqual({
      ok: true,
      id: 'link-2'
    })
    expect(JSON.parse(planeFetch.mock.calls[3][2].body)).toEqual({
      title: 'PR',
      url: 'https://example.com/pr'
    })
    await expect(issueAttachments('AIF-1')).resolves.toMatchObject([
      { id: 'asset-1', name: 'trace.txt', size: 42 }
    ])
  })
})
