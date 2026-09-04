import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaneProject, PlaneWorkspace } from '../../shared/plane-types'

const OLD_FETCH = globalThis.fetch
const { netFetchMock, resolveProxyMock, setProxyMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  resolveProxyMock: vi.fn(),
  setProxyMock: vi.fn()
}))

let tempHome = ''

const workspace: PlaneWorkspace = {
  id: 'ws-1',
  slug: 'acme',
  name: 'acme',
  baseUrl: 'https://api.plane.so',
  appUrl: 'https://app.plane.so',
  deployment: 'cloud'
}
const project: PlaneProject = { id: 'p-1', identifier: 'PROJ', name: 'Platform' }
const client = { workspace, apiToken: 'plane_api_secret' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function rawWorkItem(sequenceId: number): Record<string, unknown> {
  return {
    id: `wi-${sequenceId}`,
    sequence_id: sequenceId,
    name: `Item ${sequenceId}`,
    state: { id: 's-todo', name: 'Todo', group: 'unstarted' },
    assignees: [],
    labels: []
  }
}

async function loadWorkItems() {
  vi.resetModules()
  vi.doMock('electron', () => ({
    net: { fetch: netFetchMock },
    safeStorage: { isEncryptionAvailable: () => false },
    session: { defaultSession: { resolveProxy: resolveProxyMock, setProxy: setProxyMock } }
  }))
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  const [reads, writes] = await Promise.all([import('./work-items'), import('./work-item-write')])
  return { ...reads, ...writes }
}

function requestedUrls(): string[] {
  return netFetchMock.mock.calls.map((call) => String(call[0]))
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-plane-items-'))
  globalThis.fetch = vi.fn(async () => {
    throw new Error('global fetch must not be used; Plane goes through net.fetch')
  }) as unknown as typeof fetch
  netFetchMock.mockReset()
  resolveProxyMock.mockReset()
  setProxyMock.mockReset()
  resolveProxyMock.mockResolvedValue('DIRECT')
})

afterEach(() => {
  globalThis.fetch = OLD_FETCH
})

describe('parsePlaneWorkItemKey', () => {
  it('splits a key on its last dash', async () => {
    const { parsePlaneWorkItemKey } = await loadWorkItems()
    expect(parsePlaneWorkItemKey(' proj-123 ')).toEqual({
      projectIdentifier: 'PROJ',
      sequenceId: 123
    })
  })

  it.each(['PROJ', 'PROJ-0', 'PROJ-abc', '-12', 'TEAM_CORE-1'])('rejects %s', async (key) => {
    const { parsePlaneWorkItemKey } = await loadWorkItems()
    expect(parsePlaneWorkItemKey(key)).toBeNull()
  })
})

describe('getWorkItemByKey', () => {
  it('resolves through the workspace endpoint with expansion requested', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse(rawWorkItem(123)))
    const { getWorkItemByKey } = await loadWorkItems()
    const item = await getWorkItemByKey(client, 'PROJ-123', project)

    expect(item).toMatchObject({
      key: 'PROJ-123',
      url: 'https://app.plane.so/acme/browse/PROJ-123/'
    })
    // Without expand, Plane returns bare ids and the row cannot be mapped.
    expect(requestedUrls()[0]).toBe(
      'https://api.plane.so/api/v1/workspaces/acme/work-items/PROJ-123/?expand=state%2Cassignees%2Clabels'
    )
  })

  it('retries a bare-id payload through the relationship fallback', async () => {
    // Regression: a direct read of a work item from a deployment that ignores
    // expand mapped to null and looked like "not found".
    netFetchMock
      .mockResolvedValueOnce(jsonResponse({ ...rawWorkItem(123), state: 's-todo' }))
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ id: 's-todo', name: 'Todo', group: 'unstarted' }],
          next_page_results: false
        })
      )
      .mockImplementation(async () => jsonResponse({ results: [], next_page_results: false }))
    const { getWorkItemByKey } = await loadWorkItems()
    await expect(getWorkItemByKey(client, 'PROJ-123', project)).resolves.toMatchObject({
      key: 'PROJ-123',
      state: { id: 's-todo', name: 'Todo' }
    })
  })

  it('returns null for a work item that does not exist', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Not found' }, 404))
    const { getWorkItemByKey } = await loadWorkItems()
    await expect(getWorkItemByKey(client, 'PROJ-999', project)).resolves.toBeNull()
  })

  it('does not call the api for a malformed key', async () => {
    const { getWorkItemByKey } = await loadWorkItems()
    await expect(getWorkItemByKey(client, 'not-a-key', project)).resolves.toBeNull()
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a non-404 failure instead of reporting "not found"', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Server exploded' }, 500))
    const { getWorkItemByKey } = await loadWorkItems()
    await expect(getWorkItemByKey(client, 'PROJ-1', project)).rejects.toThrow('Server exploded')
  })
})

describe('listWorkItems', () => {
  it('follows the cursor and maps every page', async () => {
    netFetchMock
      .mockResolvedValueOnce(
        jsonResponse({ results: [rawWorkItem(1)], next_cursor: 'c2', next_page_results: true })
      )
      .mockResolvedValueOnce(jsonResponse({ results: [rawWorkItem(2)], next_page_results: false }))
    const { listWorkItems } = await loadWorkItems()
    const result = await listWorkItems(client, project)

    expect(result.items.map((item) => item.key)).toEqual(['PROJ-1', 'PROJ-2'])
    expect(result.truncated).toBe(false)
    expect(requestedUrls()[1]).toContain('cursor=c2')
  })

  it('reports truncation instead of silently dropping rows', async () => {
    netFetchMock.mockResolvedValue(
      jsonResponse({
        results: [rawWorkItem(1), rawWorkItem(2), rawWorkItem(3)],
        next_cursor: 'c2',
        next_page_results: true
      })
    )
    const { listWorkItems } = await loadWorkItems()
    const result = await listWorkItems(client, project, { maxItems: 2 })
    expect(result.items).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('recovers a row whose state was not expanded by re-mapping against project states', async () => {
    // Some deployments ignore `expand`, returning a bare state id. Dropping the
    // row would show an empty backlog with no error, so the list re-maps once
    // against the project's states.
    netFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          results: [rawWorkItem(1), { ...rawWorkItem(2), state: 's-todo' }],
          next_page_results: false
        })
      )
      // The fallback loads states, labels and members so a degraded read stays
      // complete rather than resolving only the state.
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ id: 's-todo', name: 'Todo', group: 'unstarted' }],
          next_page_results: false
        })
      )
      .mockResolvedValueOnce(jsonResponse({ results: [], next_page_results: false }))
      .mockResolvedValueOnce(jsonResponse({ results: [], next_page_results: false }))
    const { listWorkItems } = await loadWorkItems()
    const result = await listWorkItems(client, project)
    expect(result.items.map((item) => item.key)).toEqual(['PROJ-1', 'PROJ-2'])
    expect(requestedUrls().some((url) => url.includes('/states/'))).toBe(true)
    expect(requestedUrls().some((url) => url.includes('/labels/'))).toBe(true)
    expect(requestedUrls().some((url) => url.includes('/members/'))).toBe(true)
  })

  it('falls back when the state expanded but labels and assignees are bare ids', async () => {
    // Regression: an expanded state skipped the fallback, dropping bare ids to [].
    netFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ ...rawWorkItem(1), assignees: ['u-1'], labels: ['l-1'] }],
          next_page_results: false
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ id: 's-todo', name: 'Todo', group: 'unstarted' }],
          next_page_results: false
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ id: 'l-1', name: 'backend' }], next_page_results: false })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ member: { id: 'u-1', display_name: 'Ada' } }],
          next_page_results: false
        })
      )
    const { listWorkItems } = await loadWorkItems()
    const result = await listWorkItems(client, project)
    expect(result.items[0]?.labels.map((label) => label.name)).toEqual(['backend'])
    expect(result.items[0]?.assignees.map((member) => member.displayName)).toEqual(['Ada'])
  })

  it('does not spend a states request when every row already mapped', async () => {
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({ results: [rawWorkItem(1)], next_page_results: false })
    )
    const { listWorkItems } = await loadWorkItems()
    await listWorkItems(client, project)
    expect(netFetchMock).toHaveBeenCalledTimes(1)
  })

  it('still drops a row whose state exists in neither the payload nor the project', async () => {
    netFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          results: [rawWorkItem(1), { ...rawWorkItem(2), state: 's-gone' }],
          next_page_results: false
        })
      )
      .mockImplementation(async () => jsonResponse({ results: [], next_page_results: false }))
    const { listWorkItems } = await loadWorkItems()
    const result = await listWorkItems(client, project)
    expect(result.items.map((item) => item.key)).toEqual(['PROJ-1'])
  })

  it('recovers assignees and labels too, not just the state', async () => {
    netFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ ...rawWorkItem(1), state: 's-todo', assignees: ['u-1'], labels: ['l-1'] }],
          next_page_results: false
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ id: 's-todo', name: 'Todo', group: 'unstarted' }],
          next_page_results: false
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ id: 'l-1', name: 'backend' }], next_page_results: false })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ member: { id: 'u-1', display_name: 'Ada' } }],
          next_page_results: false
        })
      )
    const { listWorkItems } = await loadWorkItems()
    const result = await listWorkItems(client, project)
    expect(result.items[0]?.labels.map((label) => label.name)).toEqual(['backend'])
    expect(result.items[0]?.assignees.map((member) => member.displayName)).toEqual(['Ada'])
  })
})

describe('searchWorkItems', () => {
  it('maps the lite search projection and searches the whole workspace by default', async () => {
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        issues: [
          {
            id: 'wi-1',
            name: 'Add OAuth',
            sequence_id: 123,
            project__identifier: 'proj',
            project_id: 'p-1'
          },
          { id: 'wi-2', name: 'No project', sequence_id: 5 }
        ]
      })
    )
    const { searchWorkItems } = await loadWorkItems()
    const results = await searchWorkItems(client, 'oauth')

    expect(results).toEqual([
      {
        id: 'wi-1',
        key: 'PROJ-123',
        sequenceId: 123,
        title: 'Add OAuth',
        projectId: 'p-1',
        projectIdentifier: 'PROJ'
      }
    ])
    expect(requestedUrls()[0]).toContain('workspace_search=true')
  })

  it('scopes to one project when a project id is given', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ issues: [] }))
    const { searchWorkItems } = await loadWorkItems()
    await searchWorkItems(client, 'oauth', { projectId: 'p-1' })
    // The endpoint only honours project_id when workspace_search is false.
    expect(requestedUrls()[0]).toContain('workspace_search=false')
    expect(requestedUrls()[0]).toContain('project_id=p-1')
  })

  it('skips the request for a blank query', async () => {
    const { searchWorkItems } = await loadWorkItems()
    await expect(searchWorkItems(client, '   ')).resolves.toEqual([])
    expect(netFetchMock).not.toHaveBeenCalled()
  })
})

describe('writes', () => {
  it('sends only the fields an update names, and clears with an empty array', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({}))
    const { updateWorkItem } = await loadWorkItems()
    await updateWorkItem(client, project, 'wi-1', { stateId: 's-done', assigneeIds: null })

    const body = JSON.parse(String(netFetchMock.mock.calls[0]?.[1]?.body))
    expect(body).toEqual({ state: 's-done', assignees: [] })
    expect(netFetchMock.mock.calls[0]?.[1]?.method).toBe('PATCH')
  })

  it('skips the request when an update names no fields', async () => {
    const { updateWorkItem } = await loadWorkItems()
    await expect(updateWorkItem(client, project, 'wi-1', {})).resolves.toEqual({ ok: true })
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('posts a comment as escaped html', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ id: 'c-1' }, 201))
    const { addComment } = await loadWorkItems()
    await expect(addComment(client, project, 'wi-1', '<b>done</b>')).resolves.toEqual({ ok: true })

    const body = JSON.parse(String(netFetchMock.mock.calls[0]?.[1]?.body))
    expect(body.comment_html).toBe('<p>&lt;b&gt;done&lt;/b&gt;</p>')
  })

  it('refuses an empty comment without calling the api', async () => {
    const { addComment } = await loadWorkItems()
    await expect(addComment(client, project, 'wi-1', '  ')).resolves.toMatchObject({ ok: false })
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns the created key and browse url', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ id: 'wi-9', sequence_id: 9 }, 201))
    const { createWorkItem } = await loadWorkItems()
    await expect(
      createWorkItem(client, project, { projectId: project.id, title: 'New work' })
    ).resolves.toEqual({
      ok: true,
      id: 'wi-9',
      key: 'PROJ-9',
      url: 'https://app.plane.so/acme/browse/PROJ-9/'
    })
  })

  it('reports a create that returned no identifier rather than pretending success', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({}, 201))
    const { createWorkItem } = await loadWorkItems()
    await expect(
      createWorkItem(client, project, { projectId: project.id, title: 'New work' })
    ).resolves.toMatchObject({ ok: false })
  })

  it('does not issue a move when the work item is already in that state', async () => {
    const { moveWorkItemToState } = await loadWorkItems()
    const workItem = {
      id: 'wi-1',
      key: 'PROJ-1',
      sequenceId: 1,
      title: 'Item',
      url: 'https://app.plane.so/acme/browse/PROJ-1/',
      project,
      state: { id: 's-done', name: 'Done', group: 'completed' as const },
      labels: [],
      assignees: [],
      priority: 'none' as const,
      createdAt: '',
      updatedAt: ''
    }
    await expect(moveWorkItemToState(client, project, workItem, 's-done')).resolves.toEqual({
      ok: true,
      workItem
    })
    expect(netFetchMock).not.toHaveBeenCalled()
  })
})

describe('listComments', () => {
  it('expands the actor so comments are not authorless', async () => {
    // Regression: without expand the actor arrives as a bare uuid, mapPlaneMember
    // returns null for a non-object, and every comment rendered without a user.
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            id: 'c-1',
            comment_html: '<p>Shipped &amp; verified</p>',
            created_at: '2026-08-01T00:00:00Z',
            actor: { id: 'u-1', display_name: 'Ada' }
          }
        ],
        next_page_results: false
      })
    )
    const { listComments } = await loadWorkItems()
    const comments = await listComments(client, project, 'wi-1')

    expect(requestedUrls()[0]).toContain('expand=actor')
    expect(comments).toEqual([
      {
        id: 'c-1',
        body: 'Shipped & verified',
        createdAt: '2026-08-01T00:00:00Z',
        user: { id: 'u-1', displayName: 'Ada' }
      }
    ])
  })

  it('keeps a comment whose author cannot be resolved', async () => {
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [{ id: 'c-1', comment_html: '<p>hi</p>', created_at: '2026-08-01T00:00:00Z' }],
        next_page_results: false
      })
    )
    const { listComments } = await loadWorkItems()
    const comments = await listComments(client, project, 'wi-1')
    expect(comments).toHaveLength(1)
    expect(comments[0]?.user).toBeUndefined()
  })

  it('drops a row with no id rather than emitting a comment that cannot be addressed', async () => {
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({ results: [{ comment_html: '<p>hi</p>' }], next_page_results: false })
    )
    const { listComments } = await loadWorkItems()
    await expect(listComments(client, project, 'wi-1')).resolves.toEqual([])
  })
})
