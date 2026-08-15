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
  planeWebUrl: (client: PlaneClientForInstance, identifier: string) =>
    `${client.instance.baseUrl}/${client.instance.workspaceSlug}/issues/${identifier}`
}))

function client(
  overrides: Partial<PlaneClientForInstance['instance']> = {}
): PlaneClientForInstance {
  return {
    apiKey: 'token',
    instance: {
      id: 'https://plane.example::acme',
      baseUrl: 'https://plane.example',
      workspaceSlug: 'acme',
      displayName: 'Ada',
      email: 'ada@example.com',
      userId: 'user-1',
      ...overrides
    }
  }
}

function project(id = 'project-1') {
  return { id, name: 'Project', identifier: 'AIF' }
}

function issue(id: string, sequenceId: number, extras: Record<string, unknown> = {}) {
  return {
    id,
    name: `Issue ${sequenceId}`,
    sequence_id: sequenceId,
    project: project(),
    state: { id: 'state-1', name: 'Todo', group: 'started' },
    assignees: [{ id: 'user-1', display_name: 'Ada', email: 'ada@example.com' }],
    labels: [{ id: 'label-1', name: 'Bug' }],
    priority: 'high',
    created_by: 'user-1',
    ...extras
  }
}

describe('Plane issue API adapter', () => {
  beforeEach(() => {
    planeFetch.mockReset()
    getClient.mockReset()
    getClients.mockReset()
    getClient.mockReturnValue(client())
    getClients.mockReturnValue([client()])
  })

  it('paginates project work items with expanded fields and filters assigned to current user', async () => {
    planeFetch
      .mockResolvedValueOnce({ results: [project()] })
      .mockResolvedValueOnce({
        results: [issue('issue-1', 1), issue('issue-2', 2, { assignees: [{ id: 'user-2' }] })],
        next_cursor: '2:1:0',
        next_page_results: true
      })
      .mockResolvedValueOnce({
        results: [issue('issue-3', 3)],
        next_page_results: false
      })
    const { listIssues } = await import('./issues')

    await expect(listIssues('assigned', 2)).resolves.toMatchObject({
      items: [
        { id: 'issue-1', identifier: 'AIF-1', assigneeIds: ['user-1'], labelIds: ['label-1'] },
        { id: 'issue-3', identifier: 'AIF-3' }
      ],
      hasMore: false
    })
    expect(planeFetch.mock.calls[1][1]).toContain(
      'expand=assignees%2Clabels%2Cstate%2Cproject%2Cmodule%2Ctype'
    )
    expect(planeFetch.mock.calls[2][1]).toContain('cursor=2%3A1%3A0')
  })

  it('maps project_detail when project is absent', async () => {
    planeFetch.mockResolvedValueOnce(
      issue('issue-1', 1, {
        project: undefined,
        project_detail: { id: 'project-detail-1', identifier: 'PD', name: 'Detail project' },
        project_identifier: undefined
      })
    )
    const { getIssue } = await import('./issues')

    await expect(getIssue('PD-1')).resolves.toMatchObject({
      project: { id: 'project-detail-1', identifier: 'PD', name: 'Detail project' }
    })
  })

  it('writes documented create fields including module cycle type estimate and external source', async () => {
    planeFetch.mockResolvedValueOnce(issue('issue-1', 1))
    planeFetch.mockResolvedValueOnce({ results: [project()] })
    const { createIssue } = await import('./issues')

    await expect(
      createIssue({
        projectId: 'project-1',
        title: 'Ship Plane',
        description: 'Body',
        stateId: 'state-1',
        priority: 'high',
        cycleId: 'cycle-1',
        moduleId: 'module-1',
        typeId: 'type-1',
        estimatePoint: 3,
        externalSource: 'orca',
        externalId: 'AIF-8009'
      })
    ).resolves.toMatchObject({ ok: true, identifier: 'AIF-1' })
    expect(JSON.parse(planeFetch.mock.calls[0][2].body)).toEqual({
      name: 'Ship Plane',
      description: 'Body',
      description_html: 'Body',
      state: 'state-1',
      assignees: undefined,
      labels: undefined,
      priority: 'high',
      cycle: 'cycle-1',
      module: 'module-1',
      type_id: 'type-1',
      estimate_point: 3,
      external_source: 'orca',
      external_id: 'AIF-8009'
    })
  })

  it('matches created filter when Plane expands created_by as an object', async () => {
    planeFetch.mockResolvedValueOnce({ results: [project()] }).mockResolvedValueOnce({
      results: [
        issue('issue-1', 1, { created_by: { id: 'user-1', display_name: 'Ada' } }),
        issue('issue-2', 2, { created_by: { id: 'user-2', display_name: 'Grace' } })
      ],
      next_page_results: false
    })
    const { listIssues } = await import('./issues')

    await expect(listIssues('created', 10)).resolves.toMatchObject({
      items: [{ id: 'issue-1', createdById: 'user-1' }]
    })
  })

  it('writes update fields using Plane payload names', async () => {
    planeFetch.mockResolvedValueOnce(issue('issue-1', 1)).mockResolvedValueOnce(undefined)
    const { updateIssue } = await import('./issues')

    await expect(
      updateIssue('AIF-1', {
        title: 'Updated',
        typeId: 'type-1',
        moduleId: 'module-1',
        cycleId: 'cycle-1',
        estimatePoint: 5
      })
    ).resolves.toEqual({ ok: true })
    expect(JSON.parse(planeFetch.mock.calls[1][2].body)).toMatchObject({
      name: 'Updated',
      type_id: 'type-1',
      module: 'module-1',
      cycle: 'cycle-1',
      estimate_point: 5
    })
  })

  it('lists planning metadata resources for a project', async () => {
    planeFetch
      .mockResolvedValueOnce({
        results: [{ id: 'cycle-1', name: 'Cycle 1', status: 'started' }],
        next_cursor: '100:1:0',
        next_page_results: true
      })
      .mockResolvedValueOnce({
        results: [{ id: 'cycle-2', name: 'Cycle 2' }],
        next_page_results: false
      })
      .mockResolvedValueOnce({ results: [{ id: 'module-1', name: 'Module 1', status: 'planned' }] })
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

  it('lists and creates work item links and lists attachment metadata', async () => {
    planeFetch
      .mockResolvedValueOnce(issue('issue-1', 1))
      .mockResolvedValueOnce({
        results: [{ id: 'link-1', title: 'Spec', url: 'https://example.com' }]
      })
      .mockResolvedValueOnce(issue('issue-1', 1))
      .mockResolvedValueOnce({ id: 'link-2', title: 'PR', url: 'https://example.com/pr' })
      .mockResolvedValueOnce(issue('issue-1', 1))
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
