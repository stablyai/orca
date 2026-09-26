import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearPersonalReadScope } from '../../shared/linear/personal-read-types'

const mocks = vi.hoisted(() => ({
  raw: vi.fn(),
  team: vi.fn(),
  guard: vi.fn(),
  load: vi.fn(),
  workspace: { id: 'org', credentialRevision: 1 }
}))
const scope: LinearPersonalReadScope = {
  profileId: 'profile',
  workspaceId: 'org',
  viewerId: 'viewer',
  credentialRevision: 1,
  credentialEpoch: 'epoch'
}
vi.mock('./linear-personal-read', () => ({ readWithVerifiedLinearViewer: mocks.guard }))
vi.mock('./client', () => ({
  isAuthError: () => false,
  getClients: () => [{ workspace: mocks.workspace, client: { team: mocks.team } }]
}))
vi.mock('./linear-workspace-registry', () => ({
  getWorkspaceState: () => ({ workspaces: [mocks.workspace] })
}))
vi.mock('./linear-issue-query-support', () => ({
  getListIssueConnectionLoader: () => mocks.load,
  mapRawIssueForWorkspace: (_: unknown, node: unknown) => node
}))
import { readLinearInbox } from './linear-inbox'
import { readLinearTriage } from './linear-triage'
import { readAttentionCursor, saveAttentionCursor } from './linear-attention-cursors'

const notification = (kind: string) => ({
  __typename: kind,
  id: kind,
  type: 'event',
  title: 'Review requested',
  subtitle: 'A change',
  url: 'https://linear.app/example/issue/ABC-1',
  readAt: null,
  snoozedUntilAt: null,
  updatedAt: '2026-09-21T00:00:00Z',
  user: { id: 'viewer' },
  issue: {
    id: 'uuid',
    identifier: 'ABC-1',
    title: 'An issue',
    url: 'https://linear.app/example/issue/ABC-1'
  }
})
const response = (nodes = [notification('IssueNotification')], more = false) => ({
  data: {
    notifications: {
      nodes,
      pageInfo: { hasNextPage: more, endCursor: more ? 'provider-cursor' : null }
    }
  }
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.guard.mockImplementation(async (_id, read) => ({
    scope,
    data: await read({ client: { rawRequest: mocks.raw } }, scope)
  }))
  mocks.raw.mockResolvedValue(response())
  mocks.team.mockResolvedValue({
    triageEnabled: true,
    organization: Promise.resolve({ id: 'org' }),
    triageIssueState: Promise.resolve({ id: 'triage-state', type: 'triage' })
  })
  mocks.load.mockResolvedValue({ nodes: [], pageInfo: { hasNextPage: false } })
})

describe('read-only Linear attention', () => {
  it('verifies before every page and preserves union kinds without issue actions for other kinds', async () => {
    mocks.raw.mockResolvedValue(
      response(
        [
          notification('IssueNotification'),
          notification('ProjectNotification'),
          notification('FutureNotification')
        ],
        true
      )
    )
    const first = await readLinearInbox({ workspaceId: 'org' })
    expect(first.items.map((item) => item.kind)).toEqual([
      'IssueNotification',
      'ProjectNotification',
      'FutureNotification'
    ])
    expect(first.items[0].issue?.id).toBe('uuid')
    expect(first.items[1].issue).toBeNull()
    expect(first.items[2].readAt).toBeNull()
    expect(first.nextCursor).not.toBe('provider-cursor')
    mocks.raw.mockResolvedValue(response())
    await readLinearInbox({ workspaceId: 'org', cursor: first.nextCursor! })
    expect(mocks.guard).toHaveBeenCalledTimes(2)
    expect(mocks.raw).toHaveBeenLastCalledWith(expect.stringContaining('query OrcaPersonalInbox'), {
      first: 50,
      after: 'provider-cursor'
    })
  })
  it('does not expose another recipient or partial data', async () => {
    const wrong = notification('IssueNotification')
    wrong.user.id = 'someone-else'
    mocks.raw.mockResolvedValue(response([wrong]))
    await expect(readLinearInbox({ workspaceId: 'org' })).rejects.toThrow('different viewer')
    mocks.raw.mockResolvedValue({ ...response(), errors: [{ message: 'rate limited' }] })
    await expect(readLinearInbox({ workspaceId: 'org' })).rejects.toThrow('incomplete')
  })
  it('propagates revoked or rate-limited reads without an empty success', async () => {
    mocks.guard.mockRejectedValue(new Error('revoked'))
    await expect(readLinearInbox({ workspaceId: 'org' })).rejects.toThrow('revoked')
    expect(mocks.raw).not.toHaveBeenCalled()
  })
  it('distinguishes disabled Triage from an empty enabled queue', async () => {
    mocks.team.mockResolvedValue({
      triageEnabled: false,
      organization: Promise.resolve({ id: 'org' })
    })
    expect((await readLinearTriage({ workspaceId: 'org', teamId: 'team' })).unavailable).toContain(
      'not enabled'
    )
    expect(mocks.load).not.toHaveBeenCalled()
  })
  it('rejects an unrelated team and incomplete pages', async () => {
    mocks.team.mockResolvedValue({
      triageEnabled: true,
      organization: Promise.resolve({ id: 'other' })
    })
    await expect(readLinearTriage({ workspaceId: 'org', teamId: 'team' })).rejects.toThrow(
      'another workspace'
    )
  })
  it('returns enabled empty Triage with no unavailable message', async () => {
    expect(await readLinearTriage({ workspaceId: 'org', teamId: 'team' })).toEqual({
      items: [],
      nextCursor: null
    })
    expect(mocks.load).toHaveBeenCalledWith({ first: 50, after: undefined })
  })
  it('binds opaque cursors to the identity and expires them', () => {
    vi.useFakeTimers()
    const cursor = saveAttentionCursor('identity-one', { hasNextPage: true, endCursor: 'opaque' })!
    expect(readAttentionCursor(cursor, 'identity-one')).toBe('opaque')
    expect(() => readAttentionCursor(cursor, 'identity-two')).toThrow('changed')
    vi.advanceTimersByTime(11 * 60 * 1000)
    expect(() => readAttentionCursor(cursor, 'identity-one')).toThrow('expired')
    vi.useRealTimers()
    expect(() =>
      saveAttentionCursor('scope', { hasNextPage: true, endCursor: 'same' }, 'same')
    ).toThrow('incomplete')
  })
})
