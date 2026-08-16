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
    auth: { kind: 'apiKey', apiKey: 'token' },
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

  it('serializes legacy assigned filters as server-side Plane filters', async () => {
    planeFetch
      .mockResolvedValueOnce({
        results: [issue('issue-1', 1)],
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
      ]
    })
    expect(planeFetch.mock.calls[0][1]).toContain(
      'expand=assignees%2Clabels%2Cstate%2Cproject%2Ccycle%2Cmodule%2Ctype'
    )
    expect(planeFetch.mock.calls[0][1]).toContain('filters=%7B%22assignee_id%22%3A%22user-1%22%7D')
    expect(planeFetch.mock.calls[1][1]).toContain('cursor=2%3A1%3A0')
  })

  it('stops legacy list pagination when Plane returns an empty page with another cursor', async () => {
    planeFetch.mockResolvedValueOnce({
      results: [],
      next_cursor: '2:1:0',
      next_page_results: true
    })
    const { listIssues } = await import('./issues')

    await expect(listIssues('assigned', 2)).resolves.toEqual({ items: [] })
    expect(planeFetch).toHaveBeenCalledTimes(1)
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

  it('maps canonical raw work item id fields when relations are not expanded', async () => {
    planeFetch.mockResolvedValueOnce(
      issue('issue-1', 1, {
        assignees: undefined,
        labels: undefined,
        cycle: undefined,
        module: undefined,
        type: undefined,
        assignee_ids: ['user-1'],
        label_ids: ['label-1'],
        cycle_id: 'cycle-1',
        module_ids: ['module-1'],
        type_id: 'type-1'
      })
    )
    const { getIssue } = await import('./issues')

    await expect(getIssue('AIF-1')).resolves.toMatchObject({
      assigneeIds: ['user-1'],
      labelIds: ['label-1'],
      cycleId: 'cycle-1',
      moduleId: 'module-1',
      typeId: 'type-1'
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

  it('serializes legacy created filters as server-side Plane filters', async () => {
    planeFetch.mockResolvedValueOnce({
      results: [
        issue('issue-1', 1, { created_by: { id: 'user-1', display_name: 'Ada' } }),
        issue('issue-2', 2, { created_by: { id: 'user-2', display_name: 'Grace' } })
      ],
      next_page_results: false
    })
    const { listIssues } = await import('./issues')

    await expect(listIssues('created', 10)).resolves.toMatchObject({
      items: [
        { id: 'issue-1', createdById: 'user-1' },
        { id: 'issue-2', createdById: 'user-2' }
      ]
    })
    const url = new URL(`https://orca.test${planeFetch.mock.calls[0][1]}`)
    expect(JSON.parse(url.searchParams.get('filters') ?? '{}')).toEqual({
      created_by_id: 'user-1'
    })
  })

  it('lists work items with structured Plane filters via workspace endpoint query params', async () => {
    planeFetch.mockResolvedValueOnce({
      results: [issue('issue-1', 1)],
      next_page_results: false
    })
    const { listIssues } = await import('./issues')

    await expect(
      listIssues(
        {
          preset: 'open',
          query: 'oauth',
          priority: 'high',
          assigneeId: 'unassigned',
          labelId: 'none',
          cycleId: 'cycle-1',
          moduleId: 'none',
          orderBy: '-created_at'
        },
        10
      )
    ).resolves.toMatchObject({ items: [{ id: 'issue-1' }] })
    const url = new URL(`https://orca.test${planeFetch.mock.calls[0][1]}`)
    expect(url.pathname).toBe('/api/v1/workspaces/acme/work-items/')
    expect(url.searchParams.get('search')).toBe('oauth')
    expect(url.searchParams.get('order_by')).toBe('-created_at')
    expect(url.searchParams.get('pql')).toContain('stateGroup IN (openStates())')
    expect(url.searchParams.get('pql')).toContain('hasNoAssignee()')
    expect(url.searchParams.get('pql')).toContain('hasNoLabel()')
    expect(JSON.parse(url.searchParams.get('filters') ?? '{}')).toEqual({
      and: [{ priority: 'high' }, { cycle_id: 'cycle-1' }, { module_id: null }]
    })
  })

  it('serializes dropdown filter state into Plane filters JSON', async () => {
    planeFetch.mockResolvedValueOnce({
      results: [issue('issue-1', 1)],
      next_page_results: false,
      total_pages: 5,
      total_results: 42
    })
    const { listIssues } = await import('./issues')

    await expect(
      listIssues(
        {
          preset: 'assigned',
          stateGroup: 'started',
          stateId: 'state-1',
          priority: 'urgent',
          assigneeId: 'user-2',
          labelId: 'label-1',
          cycleId: 'cycle-1',
          moduleId: 'module-1',
          typeId: 'type-1',
          estimatePoint: 5
        },
        10
      )
    ).resolves.toMatchObject({ totalPages: 5, totalResults: 42 })

    const url = new URL(`https://orca.test${planeFetch.mock.calls[0][1]}`)
    expect(url.pathname).toBe('/api/v1/workspaces/acme/work-items/')
    expect(url.searchParams.get('pql')).toBeNull()
    expect(JSON.parse(url.searchParams.get('filters') ?? '{}')).toEqual({
      and: [
        { assignee_id: 'user-1' },
        { state_group: 'started' },
        { state_id: 'state-1' },
        { priority: 'urgent' },
        { assignee_id: 'user-2' },
        { label_id: 'label-1' },
        { cycle_id: 'cycle-1' },
        { module_id: 'module-1' },
        { type_id: 'type-1' },
        { estimate_point: 5 }
      ]
    })
  })

  it('preserves Plane totals when a query returns fewer items than the requested page', async () => {
    planeFetch.mockResolvedValueOnce({
      results: [issue('issue-1', 1)],
      next_page_results: false,
      total_pages: 1,
      total_results: 1
    })
    const { listIssues } = await import('./issues')

    await expect(listIssues({ preset: 'all' }, 50)).resolves.toMatchObject({
      items: [{ id: 'issue-1' }],
      totalPages: 1,
      totalResults: 1
    })
  })

  it('serializes multi-select filter state into Plane filters JSON', async () => {
    planeFetch.mockResolvedValueOnce({
      results: [issue('issue-1', 1)],
      next_page_results: false
    })
    const { listIssues } = await import('./issues')

    await listIssues(
      {
        preset: 'all',
        stateGroups: ['backlog', 'started'],
        stateIds: ['state-1', 'state-2'],
        priorities: ['urgent', 'high'],
        assigneeIds: ['user-1', 'user-2'],
        labelIds: ['label-1', 'label-2']
      },
      10
    )

    const url = new URL(`https://orca.test${planeFetch.mock.calls[0][1]}`)
    expect(JSON.parse(url.searchParams.get('filters') ?? '{}')).toEqual({
      and: [
        { state_group: ['backlog', 'started'] },
        { state_id: ['state-1', 'state-2'] },
        { priority: ['urgent', 'high'] },
        { assignee_id: ['user-1', 'user-2'] },
        { label_id: ['label-1', 'label-2'] }
      ]
    })
  })

  it('uses the project work-item endpoint for a single selected project', async () => {
    planeFetch.mockResolvedValueOnce({ results: [project('project-1')] }).mockResolvedValueOnce({
      results: [issue('issue-1', 1)],
      next_page_results: false,
      total_results: 7
    })
    const { listIssues } = await import('./issues')

    await expect(
      listIssues({ preset: 'all', projectIds: ['project-1'] }, 10)
    ).resolves.toMatchObject({
      items: [{ id: 'issue-1' }],
      totalResults: 7
    })
    const url = new URL(`https://orca.test${planeFetch.mock.calls[1][1]}`)
    expect(url.pathname).toBe('/api/v1/workspaces/acme/projects/project-1/work-items/')
  })

  it('reports hasMore when a structured query fills the limit before visiting later projects', async () => {
    planeFetch.mockResolvedValueOnce({
      results: [issue('issue-1', 1)],
      next_page_results: true,
      total_results: 12
    })
    const { listIssues } = await import('./issues')

    await expect(listIssues({ preset: 'all' }, 1)).resolves.toMatchObject({
      items: [{ id: 'issue-1' }],
      hasMore: true,
      totalResults: 12
    })
    expect(planeFetch).toHaveBeenCalledTimes(1)
  })

  it('stops structured query pagination when Plane returns an empty page with another cursor', async () => {
    planeFetch.mockResolvedValueOnce({ results: [project()] }).mockResolvedValueOnce({
      results: [],
      next_cursor: '2:1:0',
      next_page_results: true
    })
    const { listIssues } = await import('./issues')

    await expect(listIssues({ preset: 'assigned', projectId: 'project-1' }, 2)).resolves.toEqual({
      items: []
    })
    expect(planeFetch).toHaveBeenCalledTimes(2)
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
})
