import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { LinearClientForWorkspace } from './client'
import { loadLinearSdk } from './linear-sdk'
import { getTeamLabels, getTeamMembers, getTeamStates, getTeamStatesOrThrow } from './teams'

const mocks = vi.hoisted(() => ({
  getClients: vi.fn(),
  clearToken: vi.fn(),
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))
vi.mock('./client', () => ({
  getClients: mocks.getClients,
  isAuthError: (error: unknown) => error instanceof loadLinearSdk().AuthenticationLinearError
}))
vi.mock('./linear-token-store', () => ({ clearToken: mocks.clearToken }))
vi.mock('./linear-request-concurrency', () => ({
  acquire: mocks.acquire,
  release: mocks.release
}))

const TEAM_ID = '0c5b5142-d9a8-49bd-b487-427fa3f95089'
const WORKSPACE_ID = 'workspace-proof'
const state = { id: 'todo', name: 'Todo', type: 'unstarted', color: '#808080', position: 1 }
const label = { id: 'bug', name: 'Bug', color: '#808080', isGroup: false }
const member = { id: 'member', displayName: 'Ada', name: 'Ada', email: null, avatarUrl: null }
const rows = { states: state, labels: label, members: member }
let fetchMock: MockInstance<typeof globalThis.fetch>

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    headers: { 'content-type': 'application/json' }
  })
}

function page(field: keyof typeof rows, nodes: unknown[], hasNextPage = false): Response {
  return response({
    team: {
      [field]: {
        nodes,
        pageInfo: {
          hasNextPage,
          hasPreviousPage: false,
          startCursor: 'start',
          endCursor: hasNextPage ? 'next' : 'end'
        }
      }
    }
  })
}

function requestBodies(): string[] {
  return fetchMock.mock.calls.map(([, init]) => {
    if (typeof init?.body !== 'string') {
      throw new Error('Expected GraphQL request body')
    }
    return init.body
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected request'))
  const entry: LinearClientForWorkspace = {
    apiKey: 'intercepted-test-credential',
    workspace: {
      id: WORKSPACE_ID,
      organizationId: 'organization-proof',
      organizationName: 'Test Workspace',
      displayName: 'Ada',
      email: 'ada@example.invalid'
    },
    client: new (loadLinearSdk().LinearClient)({ apiKey: 'intercepted-test-credential' })
  }
  mocks.getClients.mockReturnValue([entry])
})
afterEach(() => vi.restoreAllMocks())

describe('Linear team metadata provider requests', () => {
  it('reads three UUID lists without a parent lookup through the shipping lazy SDK', async () => {
    fetchMock
      .mockResolvedValueOnce(page('states', [{ ...state, id: 'done', position: 2 }, state]))
      .mockResolvedValueOnce(page('labels', [{ ...label, id: 'group', isGroup: true }, label]))
      .mockResolvedValueOnce(page('members', [member]))

    const [states, labels, members] = await Promise.all([
      getTeamStates(TEAM_ID, WORKSPACE_ID),
      getTeamLabels(TEAM_ID, WORKSPACE_ID),
      getTeamMembers(TEAM_ID, WORKSPACE_ID)
    ])

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(states.map((row) => row.id)).toEqual(['todo', 'done'])
    expect(labels).toEqual([{ id: label.id, name: label.name, color: label.color }])
    expect(members).toEqual([{ id: member.id, displayName: 'Ada', name: 'Ada' }])
    for (const [index, field] of ['states', 'labels', 'members'].entries()) {
      expect(requestBodies()[index]).toContain(`query team_${field}`)
      expect(requestBodies()[index]).toContain(`"id":"${TEAM_ID}"`)
      expect(requestBodies()[index]).toContain('"first":100')
    }
    expect(mocks.getClients).toHaveBeenCalledWith(WORKSPACE_ID)
    expect(mocks.acquire).toHaveBeenCalledTimes(3)
    expect(mocks.release).toHaveBeenCalledTimes(3)
  })

  it.each([TEAM_ID, TEAM_ID.toUpperCase()])(
    'reads board states in one request for UUID %s',
    async (id) => {
      fetchMock.mockResolvedValueOnce(page('states', [state]))
      await expect(getTeamStates(id, WORKSPACE_ID)).resolves.toEqual([state])
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(requestBodies()[0]).toContain('query team_states')
      expect(requestBodies()[0]).toContain(`"id":"${id}"`)
    }
  )

  it.each([
    { field: 'states', read: getTeamStates },
    { field: 'labels', read: getTeamLabels },
    { field: 'members', read: getTeamMembers }
  ] as const)(
    'keeps SDK continuation for $field with no parent request',
    async ({ field, read }) => {
      fetchMock
        .mockResolvedValueOnce(page(field, [rows[field]], true))
        .mockResolvedValueOnce(page(field, [{ ...rows[field], id: 'second' }]))

      expect((await read(TEAM_ID, WORKSPACE_ID)).map((row) => row.id)).toEqual([
        rows[field].id,
        'second'
      ])
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(requestBodies()[1]).toContain('"after":"next"')
      for (const body of requestBodies()) {
        expect(body).toContain(`query team_${field}`)
        expect(body).toContain(`"id":"${TEAM_ID}"`)
        expect(body).toContain('"first":100')
      }
    }
  )

  it('canonicalizes a team key once and uses its UUID throughout pagination', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ team: { id: TEAM_ID } }))
      .mockResolvedValueOnce(page('states', [state], true))
      .mockResolvedValueOnce(page('states', [{ ...state, id: 'second' }]))

    expect((await getTeamStates('ENG', WORKSPACE_ID)).map((row) => row.id)).toEqual([
      'todo',
      'second'
    ])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(requestBodies()[0]).toContain('query team(')
    expect(requestBodies()[0]).toContain('"id":"ENG"')
    for (const body of requestBodies().slice(1)) {
      expect(body).toContain(`"id":"${TEAM_ID}"`)
    }
    expect(requestBodies()[2]).toContain('"after":"next"')
  })

  it.each(
    [
      { type: 'authentication error', status: 401, auth: true },
      { type: 'invalid input', status: 200, auth: false },
      { type: 'forbidden', status: 403, auth: false },
      { type: 'ratelimited', status: 429, auth: false }
    ].flatMap((error) =>
      [false, true].flatMap((continuation) =>
        [false, true].map((strict) => ({
          ...error,
          continuation,
          strict
        }))
      )
    )
  )('preserves $type errors (continuation=$continuation, strict=$strict)', async (test) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    if (test.continuation) {
      fetchMock.mockResolvedValueOnce(page('states', [state], true))
    }
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          errors: [{ message: 'Provider rejected metadata', extensions: { type: test.type } }]
        }),
        { status: test.status, headers: { 'content-type': 'application/json' } }
      )
    )

    const result = (test.strict ? getTeamStatesOrThrow : getTeamStates)(TEAM_ID, WORKSPACE_ID)
    if (test.auth) {
      await expect(result).rejects.toBeInstanceOf(loadLinearSdk().AuthenticationLinearError)
      expect(mocks.clearToken).toHaveBeenCalledExactlyOnceWith(WORKSPACE_ID)
      expect(warning).not.toHaveBeenCalled()
    } else if (test.strict) {
      await expect(result).rejects.toThrow('Provider rejected metadata')
      expect(mocks.clearToken).not.toHaveBeenCalled()
      expect(warning).not.toHaveBeenCalled()
    } else {
      await expect(result).resolves.toEqual([])
      expect(mocks.clearToken).not.toHaveBeenCalled()
      expect(warning).toHaveBeenCalledOnce()
    }
    expect(fetchMock).toHaveBeenCalledTimes(test.continuation ? 2 : 1)
    expect(mocks.acquire).toHaveBeenCalledOnce()
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('skips provider work when the selected workspace is disconnected', async () => {
    mocks.getClients.mockReturnValue([])
    await expect(getTeamStates(TEAM_ID, WORKSPACE_ID)).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.acquire).not.toHaveBeenCalled()
  })
})
