import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV
} from '../../shared/orchestration-compatibility-evidence'

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

import type { ProjectGroup } from '../../shared/project-group-types'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { REPO_GROUP_HANDLERS } from './repo-group'
import { REPO_HANDLERS } from './repo'

function group(id: string, name: string, connectionId: string | null = null): ProjectGroup {
  return {
    id,
    name,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    connectionId,
    createdAt: 0,
    updatedAt: 0
  }
}

const GROUPS = [
  group('g1', 'Clients'),
  group('g2', 'Internal'),
  group('g3', 'Clients'),
  group('g4', 'Remote', 'ssh-1')
]

const SSH_ENV = {
  [ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV]: 'ssh',
  [ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV]: 'ssh-1',
  [ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV]: 'incarnation-1',
  [ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV]: 'attachment-1'
}

const callMock = vi.fn()
const client = { call: callMock } as unknown as RuntimeClient

function run(
  handlerKey: string,
  flags: Record<string, string | boolean>,
  env: Readonly<NodeJS.ProcessEnv> = {}
): Promise<void> {
  const table = { ...REPO_HANDLERS, ...REPO_GROUP_HANDLERS }
  const ctx: HandlerContext = {
    flags: new Map(Object.entries(flags)),
    client,
    cwd: '/tmp/repo',
    env,
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
    if (method === 'repo.show') {
      return { result: { repo: { id: 'r1', connectionId: null } } }
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

  it('lists only the calling SSH host groups in a direct-SSH CLI', async () => {
    await run('repo group list', {}, SSH_ENV)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('g4  Remote'))
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('g2  Internal'))
  })

  it('creates a root group owned by the calling SSH host', async () => {
    await run('repo group create', { name: 'New' }, SSH_ENV)
    expect(callMock).toHaveBeenCalledWith('projectGroup.create', {
      name: 'New',
      connectionId: 'ssh-1'
    })
  })

  it('creates a group, resolving --parent-group to an id', async () => {
    await run('repo group create', { name: 'New', 'parent-group': 'Internal' })
    expect(callMock).toHaveBeenCalledWith('projectGroup.create', {
      name: 'New',
      parentGroupId: 'g2'
    })
  })

  it('preserves an SSH parent group owner when creating a child locally', async () => {
    await run('repo group create', { name: 'New', 'parent-group': 'id:g4' })
    expect(callMock).toHaveBeenCalledWith('projectGroup.create', {
      name: 'New',
      parentGroupId: 'g4',
      connectionId: 'ssh-1'
    })
  })

  it('does not create a group when --parent-group cannot be resolved', async () => {
    await expect(
      run('repo group create', { name: 'New', 'parent-group': 'nope' })
    ).rejects.toMatchObject({
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

  it('normalizes hex colors and rejects invalid colors', async () => {
    await run('repo group set', { group: 'id:g2', color: 'f80' })
    expect(callMock).toHaveBeenCalledWith('projectGroup.update', {
      groupId: 'g2',
      updates: { color: '#ff8800' }
    })
    callMock.mockClear()
    await expect(
      run('repo group set', { group: 'id:g2', color: 'not-a-color' })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(mutatingCalls()).toEqual([])
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
      method === 'projectGroup.list' ? { result: { groups: GROUPS } } : { result: { group: null } }
    )
    await expect(run('repo group set', { group: 'id:g2', name: 'X' })).rejects.toMatchObject({
      code: 'selector_not_found'
    })
  })

  it('removes a group by selector', async () => {
    await run('repo group rm', { group: 'id:g1' })
    expect(callMock).toHaveBeenCalledWith('projectGroup.delete', { groupId: 'g1' })
  })

  it('does not delete another host group from a direct-SSH CLI', async () => {
    await expect(run('repo group rm', { group: 'id:g1' }, SSH_ENV)).rejects.toMatchObject({
      code: 'selector_not_found'
    })
    expect(mutatingCalls()).toEqual([])
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

  it('rejects assigning a repo to a group owned by another host', async () => {
    await expect(run('repo set', { repo: 'id:r1', group: 'id:g4' })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(mutatingCalls()).toEqual(['repo.show'])
  })

  it('assigns an SSH repo to a group owned by the calling SSH host', async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === 'projectGroup.list') {
        return { result: { groups: GROUPS } }
      }
      if (method === 'repo.show') {
        return { result: { repo: { id: 'r1', connectionId: 'ssh-1' } } }
      }
      if (method === 'repo.update') {
        return { result: { repo: { id: 'r1', connectionId: 'ssh-1' } } }
      }
      throw new Error(`Unexpected RPC method ${method}`)
    })
    await run('repo set', { repo: 'id:r1', group: 'Remote' }, SSH_ENV)
    expect(callMock).toHaveBeenCalledWith('repo.update', {
      repo: 'id:r1',
      connectionId: 'ssh-1',
      updates: { projectGroupId: 'g4' }
    })
  })

  it('fences non-group updates to the calling SSH host', async () => {
    await run('repo set', { repo: 'id:r1', 'display-name': 'Remote' }, SSH_ENV)
    expect(callMock).toHaveBeenCalledWith('repo.update', {
      repo: 'id:r1',
      connectionId: 'ssh-1',
      updates: { displayName: 'Remote' }
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

  it('fences removal to the calling SSH host', async () => {
    await run('repo rm', { repo: 'id:r1' }, SSH_ENV)
    expect(callMock).toHaveBeenCalledWith('repo.rm', {
      repo: 'id:r1',
      connectionId: 'ssh-1'
    })
  })

  it('fails loudly when the runtime reports nothing was removed', async () => {
    callMock.mockResolvedValue({ result: { removed: false } })
    await expect(run('repo rm', { repo: 'id:r1' })).rejects.toMatchObject({
      code: 'selector_not_found'
    })
  })
})
