import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildProjectGroupByRepoId,
  loadRepoProjectGroupResponses
} from './project-group-membership'
import { folderWorkspaceRepoId } from '../../../src/shared/folder-workspace-worktree'
import type { RepoSummary } from './host-worktree-rpc-types'
import type { ProjectGroup } from '../../../src/shared/types'
import type { RpcClient } from '../transport/rpc-client'

function group(overrides: Partial<ProjectGroup> & { id: string }): ProjectGroup {
  return {
    name: overrides.id,
    parentPath: null,
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function repo(id: string, projectGroupId?: string | null): RepoSummary {
  return { id, displayName: id, projectGroupId }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('loadRepoProjectGroupResponses', () => {
  it('keeps repo metadata when the project-group request rejects', async () => {
    const repoResponse = {
      id: 'repo-list',
      ok: true as const,
      result: { repos: [repo('r', 'child')] },
      _meta: { runtimeId: 'runtime' }
    }
    const groupError = new Error('Request timed out: projectGroup.list')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client: Pick<RpcClient, 'sendRequest'> = {
      sendRequest: vi.fn(async (method: string) => {
        if (method === 'repo.list') {
          return repoResponse
        }
        throw groupError
      })
    }

    await expect(loadRepoProjectGroupResponses(client)).resolves.toEqual([
      repoResponse,
      { ok: false }
    ])
    expect(client.sendRequest).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith('[mobile workspaces] projectGroup.list failed', groupError)
  })

  it('keeps repo-list transport failures fatal', async () => {
    const repoError = new Error('Request timed out: repo.list')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client: Pick<RpcClient, 'sendRequest'> = {
      sendRequest: vi.fn(async (method: string) => {
        if (method === 'repo.list') {
          throw repoError
        }
        return {
          id: 'project-group-list',
          ok: true,
          result: { groups: [] },
          _meta: { runtimeId: 'runtime' }
        }
      })
    }

    await expect(loadRepoProjectGroupResponses(client)).rejects.toBe(repoError)
    expect(warn).not.toHaveBeenCalled()
  })

  it('preserves resolved project-group RPC failures', async () => {
    const repoResponse = {
      id: 'repo-list',
      ok: true as const,
      result: { repos: [] },
      _meta: { runtimeId: 'runtime' }
    }
    const groupResponse = {
      id: 'project-group-list',
      ok: false as const,
      error: { code: 'unsupported', message: 'old host' },
      _meta: { runtimeId: 'runtime' }
    }
    const client: Pick<RpcClient, 'sendRequest'> = {
      sendRequest: vi.fn(async (method: string) =>
        method === 'repo.list' ? repoResponse : groupResponse
      )
    }

    await expect(loadRepoProjectGroupResponses(client)).resolves.toEqual([
      repoResponse,
      groupResponse
    ])
  })
})

describe('buildProjectGroupByRepoId', () => {
  it('maps a repo to its top-level project group, collapsing nested subgroups', () => {
    const groups = [
      group({ id: 'root', name: 'Backend', tabOrder: 2 }),
      group({ id: 'child', parentGroupId: 'root' })
    ]

    const map = buildProjectGroupByRepoId([repo('r', 'child')], { ok: true, result: { groups } })

    expect(map.get('r')).toEqual({ groupId: 'root', groupName: 'Backend', tabOrder: 2 })
  })

  it('marks ungrouped repos and unknown memberships as null', () => {
    const map = buildProjectGroupByRepoId([repo('ungrouped', null), repo('stale', 'gone')], {
      ok: true,
      result: { groups: [] }
    })

    expect(map.get('ungrouped')).toBeNull()
    expect(map.get('stale')).toBeNull()
  })

  it('degrades to all-ungrouped when the projectGroup.list call failed', () => {
    const map = buildProjectGroupByRepoId([repo('r', 'child')], { ok: false })

    expect(map.get('r')).toBeNull()
  })

  it('maps folder-workspace synthetic repoIds to their top-level group', () => {
    const groups = [
      group({ id: 'root', name: 'Backend', tabOrder: 4 }),
      group({ id: 'child', parentGroupId: 'root' })
    ]

    const map = buildProjectGroupByRepoId([], { ok: true, result: { groups } })

    // A folder workspace directly in the root group and one in a nested subgroup
    // both resolve to the root bucket (folder-workspace-worktree.ts repoId scheme).
    expect(map.get(folderWorkspaceRepoId('root'))).toEqual({
      groupId: 'root',
      groupName: 'Backend',
      tabOrder: 4
    })
    expect(map.get(folderWorkspaceRepoId('child'))).toEqual({
      groupId: 'root',
      groupName: 'Backend',
      tabOrder: 4
    })
  })
})
