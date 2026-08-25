import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaneClientForInstance } from './client'

const planeFetch = vi.fn()
const getClient = vi.fn()

vi.mock('./client', () => ({
  getClient: (...args: unknown[]) => getClient(...args)
}))

vi.mock('./api-request', () => ({
  apiPath: (client: PlaneClientForInstance, suffix: string) =>
    `/api/v1/workspaces/${client.instance.workspaceSlug}${suffix}`,
  planeFetch: (...args: unknown[]) => planeFetch(...args)
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

function project(id = 'project-1') {
  return { id, name: 'Project', identifier: 'AIF' }
}

describe('Plane project resources', () => {
  beforeEach(() => {
    planeFetch.mockReset()
    getClient.mockReset()
    getClient.mockReturnValue(client())
  })

  it('lists planning metadata resources for a project', async () => {
    planeFetch
      .mockResolvedValueOnce({
        results: [{ id: 'cycle-1', name: 'Cycle 1', status: 'started' }],
        next_cursor: '100:1:0',
        next_page_results: true
      })
      .mockResolvedValueOnce({ results: [{ id: 'cycle-2', name: 'Cycle 2' }] })
      .mockResolvedValueOnce({ results: [{ id: 'module-1', name: 'Module 1' }] })
      .mockResolvedValueOnce({ results: [{ id: 'type-1', name: 'Bug', is_active: true }] })
      .mockResolvedValueOnce({ results: [{ id: 'estimate-1', name: 'Points' }] })
    const { listCycles, listModules, listWorkItemTypes, listEstimates } =
      await import('./project-resources')

    await expect(listCycles('project-1')).resolves.toMatchObject([
      { id: 'cycle-1' },
      { id: 'cycle-2' }
    ])
    await expect(listModules('project-1')).resolves.toMatchObject([{ id: 'module-1' }])
    await expect(listWorkItemTypes('project-1')).resolves.toMatchObject([{ id: 'type-1' }])
    await expect(listEstimates('project-1')).resolves.toMatchObject([{ id: 'estimate-1' }])
    expect(planeFetch.mock.calls[1][1]).toContain('cursor=100%3A1%3A0')
  })

  it('treats missing Plane estimates as an empty resource list', async () => {
    planeFetch.mockRejectedValueOnce(new Error('Plane API 404: {"error":"Estimate not found"}'))
    const { listEstimates } = await import('./project-resources')

    await expect(listEstimates('project-1')).resolves.toEqual([])
  })

  it('paginates project listing', async () => {
    planeFetch
      .mockResolvedValueOnce({
        results: [project('project-1')],
        next_cursor: '100:1:0',
        next_page_results: true
      })
      .mockResolvedValueOnce({ results: [project('project-2')], next_page_results: false })
    const { listProjects } = await import('./project-resources')

    await expect(listProjects()).resolves.toMatchObject([{ id: 'project-1' }, { id: 'project-2' }])
    expect(planeFetch.mock.calls[0][1]).toContain('per_page=100')
    expect(planeFetch.mock.calls[1][1]).toContain('cursor=100%3A1%3A0')
  })
})
