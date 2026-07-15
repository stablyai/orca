import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Keep the socket runtime client out of the import graph; only the error type
// is referenced by the modules under test.
vi.mock('../runtime-client', () => ({
  RuntimeClientError: class RuntimeClientError extends Error {
    readonly code: string
    readonly data?: unknown
    constructor(code: string, message: string, data?: unknown) {
      super(message)
      this.code = code
      this.data = data
    }
  },
  RuntimeRpcFailureError: class RuntimeRpcFailureError extends Error {},
  serveOrcaApp: vi.fn()
}))

import type { ProjectGroup } from '../../shared/types'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { REPO_GROUP_HANDLERS } from './repo-group'
import { REPO_HANDLERS } from './repo'

function group(id: string, name: string): ProjectGroup {
  return {
    id,
    name,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
}

const GROUPS = [group('g1', 'Clients'), group('g2', 'Internal'), group('g3', 'Clients')]

const callMock = vi.fn()
const client = { call: callMock } as unknown as RuntimeClient

function run(handlerKey: string, flags: Record<string, string | boolean>): Promise<void> {
  const table = { ...REPO_HANDLERS, ...REPO_GROUP_HANDLERS }
  const ctx: HandlerContext = {
    flags: new Map(Object.entries(flags)),
    client,
    cwd: '/tmp/repo',
    json: false
  }
  return table[handlerKey](ctx)
}

function mutatingCalls(): string[] {
  return callMock.mock.calls
    .map((call) => String(call[0]))
    .filter((method) => method !== 'projectGroup.list')
}

beforeEach(() => {
  callMock.mockReset()
  callMock.mockImplementation(async (method: string) => {
    if (method === 'projectGroup.list') {
      return { result: { groups: GROUPS } }
    }
    if (method === 'projectGroup.create') {
      return { result: { group: group('g9', 'New') } }
    }
    if (method === 'projectGroup.update') {
      return { result: { group: group('g2', 'Renamed') } }
    }
    if (method === 'projectGroup.delete') {
      return { result: { deleted: true } }
    }
    if (method === 'repo.update') {
      return { result: { repo: { id: 'r1' } } }
    }
    if (method === 'repo.rm') {
      return { result: { removed: true } }
    }
    throw new Error(`Unexpected RPC method ${method}`)
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('repo group handlers', () => {
  it('lists groups', async () => {
    await run('repo group list', {})
    expect(callMock).toHaveBeenCalledWith('projectGroup.list')
  })

  it('creates a group, resolving --parent-group to an id', async () => {
    await run('repo group create', { name: 'New', 'parent-group': 'Internal' })
    expect(callMock).toHaveBeenCalledWith('projectGroup.create', {
      name: 'New',
      parentGroupId: 'g2'
    })
  })

  it('does not create a group when --parent-group cannot be resolved', async () => {
    await expect(run('repo group create', { name: 'New', 'parent-group': 'nope' })).rejects.toMatchObject({
      code: 'selector_not_found'
    })
    expect(mutatingCalls()).toEqual([])
  })

  it('updates a group by unique name', async () => {
    await run('repo group set', { group: 'Internal', name: 'Renamed' })
    expect(callMock).toHaveBeenCalledWith('projectGroup.update', {
      groupId: 'g2',
      updates: { name: 'Renamed' }
    })
  })

  it('sends color null when --color null is passed', async () => {
    await run('repo group set', { group: 'id:g2', color: 'null' })
    expect(callMock).toHaveBeenCalledWith('projectGroup.update', {
      groupId: 'g2',
      updates: { color: null }
    })
  })

  it('rejects set with no update flags', async () => {
    await expect(run('repo group set', { group: 'id:g2' })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(mutatingCalls()).toEqual([])
  })

  it('rejects set for an ambiguous group name without issuing the update', async () => {
    await expect(run('repo group set', { group: 'Clients', name: 'X' })).rejects.toMatchObject({
      code: 'selector_ambiguous'
    })
    expect(mutatingCalls()).toEqual([])
  })

  it('fails loudly when the runtime reports the group vanished on update', async () => {
    callMock.mockImplementation(async (method: string) =>
      method === 'projectGroup.list'
        ? { result: { groups: GROUPS } }
        : { result: { group: null } }
    )
    await expect(run('repo group set', { group: 'id:g2', name: 'X' })).rejects.toMatchObject({
      code: 'selector_not_found'
    })
  })

  it('removes a group by selector', async () => {
    await run('repo group rm', { group: 'id:g1' })
    expect(callMock).toHaveBeenCalledWith('projectGroup.delete', { groupId: 'g1' })
  })

  it('fails loudly when the runtime reports nothing was deleted', async () => {
    callMock.mockImplementation(async (method: string) =>
      method === 'projectGroup.list'
        ? { result: { groups: GROUPS } }
        : { result: { deleted: false } }
    )
    await expect(run('repo group rm', { group: 'id:g1' })).rejects.toMatchObject({
      code: 'selector_not_found'
    })
  })
})

describe('repo set handler', () => {
  it('resolves --group to a project group id before updating', async () => {
    await run('repo set', { repo: 'id:r1', group: 'Internal' })
    expect(callMock).toHaveBeenCalledWith('repo.update', {
      repo: 'id:r1',
      updates: { projectGroupId: 'g2' }
    })
  })

  it('sends projectGroupId null for --ungroup', async () => {
    await run('repo set', { repo: 'id:r1', ungroup: true })
    expect(callMock).toHaveBeenCalledWith('repo.update', {
      repo: 'id:r1',
      updates: { projectGroupId: null }
    })
  })

  it('rejects --group combined with --ungroup', async () => {
    await expect(
      run('repo set', { repo: 'id:r1', group: 'Internal', ungroup: true })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(mutatingCalls()).toEqual([])
  })

  it('does not update the repo when --group cannot be resolved', async () => {
    await expect(run('repo set', { repo: 'id:r1', group: 'nope' })).rejects.toMatchObject({
      code: 'selector_not_found'
    })
    expect(mutatingCalls()).toEqual([])
  })

  it('rejects set with no update flags', async () => {
    await expect(run('repo set', { repo: 'id:r1' })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(mutatingCalls()).toEqual([])
  })

  it('normalizes --badge-color and rejects invalid values', async () => {
    await run('repo set', { repo: 'id:r1', 'badge-color': 'f80' })
    expect(callMock).toHaveBeenCalledWith('repo.update', {
      repo: 'id:r1',
      updates: { badgeColor: '#ff8800' }
    })
    callMock.mockClear()
    await expect(
      run('repo set', { repo: 'id:r1', 'badge-color': 'not-a-color' })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(mutatingCalls()).toEqual([])
  })
})

describe('repo rm handler', () => {
  it('removes a repo registration', async () => {
    await run('repo rm', { repo: 'id:r1' })
    expect(callMock).toHaveBeenCalledWith('repo.rm', { repo: 'id:r1' })
  })
})
