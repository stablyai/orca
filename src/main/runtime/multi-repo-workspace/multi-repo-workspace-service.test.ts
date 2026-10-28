import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Repo } from '../../../shared/repo-types'
import { MultiRepoWorkspaceError } from '../../../shared/multi-repo-workspace'
import { pruneMultiRepoMemberForWorktree } from '../../multi-repo-member-pruning'
import type { RuntimeStore } from '../runtime-store-contract'
import { MULTI_REPO_WORKSPACE_METHODS } from '../rpc/methods/multi-repo-workspace'
import { assertWorktreeNotMultiRepoMember } from './multi-repo-member-lock'
import type { MultiRepoWorkspacePort } from './multi-repo-workspace-port'
import { MultiRepoWorkspaceService } from './multi-repo-workspace-service'

vi.mock('../../telemetry/client', () => ({ track: vi.fn(), isTelemetryEnabled: () => false }))

let workspaceDir: string

function gitRepo(id: string): Repo {
  return { id, path: join(workspaceDir, 'repos', id), displayName: id, badgeColor: '', addedAt: 0 }
}

function createHarness(repoIds: string[]) {
  const workspaces: FolderWorkspace[] = []
  const repos = repoIds.map(gitRepo)
  const store = {
    getRepos: () => repos,
    getSettings: () => ({ workspaceDir }),
    getProjectGroups: () => [],
    getFolderWorkspaces: () => workspaces,
    updateFolderWorkspace: (id: string, updates: Partial<FolderWorkspace>) => {
      const workspace = workspaces.find((entry) => entry.id === id)
      if (!workspace) {
        return null
      }
      Object.assign(workspace, updates)
      return workspace
    },
    getWorktreeMeta: () => ({ instanceId: 'instance' }),
    setWorktreeMeta: () => ({ instanceId: 'instance' }),
    removeWorktreeLineage: () => {},
    setWorkspaceLineage: (lineage: unknown) => lineage,
    setWorktreeLineage: () => undefined
  }
  const failingRepos = new Set<string>()
  const port = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements only the store members the service touches.
    requireStore: () => store as unknown as RuntimeStore,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the port fake needs only the id the service reads.
    createProjectGroup: vi.fn(async () => ({ id: 'group' }) as never),
    createFolderWorkspace: vi.fn(async (input: { name: string; folderPath: string }) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake workspace carries only the fields the service reads.
      const workspace = {
        id: `ws-${workspaces.length + 1}`,
        name: input.name,
        folderPath: input.folderPath
      } as FolderWorkspace
      workspaces.push(workspace)
      return workspace
    }),
    deleteFolderWorkspace: vi.fn(async (id: string) => {
      const index = workspaces.findIndex((entry) => entry.id === id)
      workspaces.splice(index, 1)
      return { deleted: index !== -1 }
    }),
    createWorktree: vi.fn(
      async (args: {
        repoSelector: unknown
        placement?: { parentDir: string; leafName: string }
      }) => {
        if (typeof args.repoSelector === 'string' && failingRepos.has(args.repoSelector)) {
          throw new Error('git exploded')
        }
        const path = join(args.placement!.parentDir, args.placement!.leafName)
        await mkdir(path)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake result carries only the worktree fields the service reads.
        return {
          worktree: {
            id: `${String(args.repoSelector)}::${path}`,
            instanceId: 'i',
            branch: 'refs/heads/feature'
          }
        } as never
      }
    ),
    removeWorktree: vi.fn(async (worktreeId: string) => {
      pruneMultiRepoMemberForWorktree(store, worktreeId)
      return {}
    }),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake lists no worktrees; only the array shape is read.
    listDetectedWorktrees: vi.fn(async () => ({ worktrees: [] }) as never),
    notifyChanged: vi.fn()
  } satisfies MultiRepoWorkspacePort
  return { service: new MultiRepoWorkspaceService(port), port, store, workspaces, failingRepos }
}

async function settle(workspaces: FolderWorkspace[]): Promise<FolderWorkspace> {
  await vi.waitFor(() => {
    const members = workspaces[0]?.multiRepo?.members ?? []
    expect(members.length).toBeGreaterThan(0)
    expect(
      members.every((member) => member.state !== 'queued' && member.state !== 'creating')
    ).toBe(true)
  })
  return workspaces[0]
}

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'multi-repo-'))
})

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true })
})

describe('multi-repo create and retry', () => {
  it('keeps successful members when one fails, then retry adopts nothing and succeeds', async () => {
    const { service, port, workspaces, failingRepos } = createHarness(['a', 'b'])
    failingRepos.add('b')
    await service.create({ name: 'Feature X', members: [{ repoId: 'a' }, { repoId: 'b' }] })
    const settled = await settle(workspaces)
    const [a, b] = settled.multiRepo!.members
    expect(a.state).toBe('ready')
    expect(b).toMatchObject({ state: 'failed', failure: { code: 'git_failed' } })
    expect(port.createWorktree).toHaveBeenCalledTimes(2)

    failingRepos.clear()
    await service.retryMember(settled.id, b.memberId)
    expect(workspaces[0].multiRepo!.members.map((member) => member.state)).toEqual([
      'ready',
      'ready'
    ])
  })

  it('adopts a worktree already registered at the expected path on retry', async () => {
    const { service, port, workspaces, failingRepos } = createHarness(['a', 'b'])
    failingRepos.add('b')
    await service.create({ name: 'Adopt', members: [{ repoId: 'a' }, { repoId: 'b' }] })
    const settled = await settle(workspaces)
    const failed = settled.multiRepo!.members[1]
    const path = join(settled.folderPath, failed.dirName)
    await mkdir(path)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adopted-worktree fake carries only the fields tryAdopt reads.
    port.listDetectedWorktrees.mockResolvedValue({
      worktrees: [
        { id: `b::${path}`, repoId: 'b', path, branch: 'refs/heads/adopt', instanceId: 'x' }
      ]
    } as never)
    port.createWorktree.mockClear()

    await service.retryMember(settled.id, failed.memberId)

    expect(port.createWorktree).not.toHaveBeenCalled()
    expect(workspaces[0].multiRepo!.members[1]).toMatchObject({
      state: 'ready',
      branchName: 'adopt'
    })
  })

  it('fails with path_occupied for an unregistered occupant and never deletes it', async () => {
    const { service, workspaces, failingRepos } = createHarness(['a', 'b'])
    failingRepos.add('b')
    await service.create({ name: 'Occupied', members: [{ repoId: 'a' }, { repoId: 'b' }] })
    const settled = await settle(workspaces)
    const failed = settled.multiRepo!.members[1]
    const occupant = join(settled.folderPath, failed.dirName, 'keep.txt')
    await mkdir(join(settled.folderPath, failed.dirName))
    await writeFile(occupant, 'user data')

    await service.retryMember(settled.id, failed.memberId)

    expect(workspaces[0].multiRepo!.members[1].failure?.code).toBe('path_occupied')
    expect(existsSync(occupant)).toBe(true)
  })

  it('is idempotent per clientMutationId', async () => {
    const { service, port } = createHarness(['a', 'b'])
    const input = {
      name: 'Once',
      members: [{ repoId: 'a' }, { repoId: 'b' }],
      clientMutationId: 'm1'
    }
    const [first, second] = await Promise.all([service.create(input), service.create(input)])
    expect(second).toBe(first)
    expect(port.createFolderWorkspace).toHaveBeenCalledTimes(1)
  })
})

describe('multi-repo delete', () => {
  it('keeps the parent when a member fails, then skips finished members on the second call', async () => {
    const { service, port, workspaces } = createHarness(['a', 'b'])
    await service.create({ name: 'Del', members: [{ repoId: 'a' }, { repoId: 'b' }] })
    const settled = await settle(workspaces)
    const [a, b] = settled.multiRepo!.members
    port.removeWorktree.mockImplementation(async (worktreeId: string) => {
      if (worktreeId === b.worktreeId) {
        throw new Error('archive hook failed')
      }
      pruneMultiRepoMemberForWorktree(
        {
          getFolderWorkspaces: () => workspaces,
          updateFolderWorkspace: (id, updates) =>
            Object.assign(
              workspaces.find((w) => w.id === id)!,
              updates
            )
        },
        worktreeId
      )
      return {}
    })

    const first = await service.delete({ folderWorkspaceId: settled.id })

    expect(first.workspaceRemoved).toBe(false)
    expect(first.remainingMemberCount).toBe(1)
    expect(first.members.map((outcome) => outcome.status)).toEqual(['removed', 'failed'])
    expect(port.deleteFolderWorkspace).not.toHaveBeenCalled()

    port.removeWorktree.mockClear()
    port.removeWorktree.mockImplementation(async (worktreeId: string) => {
      Object.assign(workspaces[0], {
        multiRepo: { ...workspaces[0].multiRepo!, members: [] }
      })
      return { worktreeId }
    })
    const second = await service.delete({ folderWorkspaceId: settled.id })
    expect(port.removeWorktree).toHaveBeenCalledTimes(1)
    expect(port.removeWorktree).toHaveBeenCalledWith(b.worktreeId, expect.anything())
    expect(a.worktreeId).not.toBe(b.worktreeId)
    expect(second.workspaceRemoved).toBe(true)
  })

  it('finishes when a member never had a worktree, dropping it from the record', async () => {
    const { service, port, workspaces, failingRepos } = createHarness(['a', 'b'])
    failingRepos.add('b')
    await service.create({ name: 'Partial', members: [{ repoId: 'a' }, { repoId: 'b' }] })
    const settled = await settle(workspaces)

    const result = await service.delete({ folderWorkspaceId: settled.id })

    expect(result.members.map((outcome) => outcome.status)).toEqual(['removed', 'dropped'])
    expect(result.workspaceRemoved).toBe(true)
    expect(result.remainingMemberCount).toBe(0)
    expect(port.deleteFolderWorkspace).toHaveBeenCalledWith(settled.id)
  })

  it('removes the record last and keeps a non-empty root', async () => {
    const { service, port, workspaces } = createHarness(['a', 'b'])
    await service.create({ name: 'Keep', members: [{ repoId: 'a' }, { repoId: 'b' }] })
    const settled = await settle(workspaces)
    await writeFile(join(settled.folderPath, 'notes.md'), 'agent output')
    const order: string[] = []
    port.removeWorktree.mockImplementation(async (worktreeId: string) => {
      order.push('member')
      Object.assign(workspaces[0], {
        multiRepo: {
          ...workspaces[0].multiRepo!,
          members: workspaces[0].multiRepo!.members.filter((m) => m.worktreeId !== worktreeId)
        }
      })
      return {}
    })
    port.deleteFolderWorkspace.mockImplementation(async () => {
      order.push('parent')
      return { deleted: true }
    })

    const result = await service.delete({ folderWorkspaceId: settled.id })

    expect(order).toEqual(['member', 'member', 'parent'])
    expect(result.rootKept).toEqual({ path: settled.folderPath, reason: 'not_empty' })
    expect(existsSync(join(settled.folderPath, 'notes.md'))).toBe(true)
  })

  it('never removes a root that sits outside the workspace directory', async () => {
    const { service, workspaces, failingRepos } = createHarness(['a', 'b'])
    failingRepos.add('a')
    failingRepos.add('b')
    await service.create({ name: 'Moved', members: [{ repoId: 'a' }, { repoId: 'b' }] })
    const settled = await settle(workspaces)
    const outside = await mkdtemp(join(tmpdir(), 'multi-repo-outside-'))
    try {
      settled.folderPath = outside

      const result = await service.delete({ folderWorkspaceId: settled.id })

      expect(result.workspaceRemoved).toBe(true)
      expect(result.rootKept).toEqual({ path: outside, reason: 'not_owned' })
      expect(existsSync(outside)).toBe(true)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects force for a member that is not part of the workspace', async () => {
    const { service, workspaces } = createHarness(['a', 'b'])
    await service.create({ name: 'Force', members: [{ repoId: 'a' }, { repoId: 'b' }] })
    const settled = await settle(workspaces)
    await expect(
      service.delete({ folderWorkspaceId: settled.id, forceMemberIds: ['nope'] })
    ).rejects.toMatchObject({ code: 'multi_repo_delete_force_not_named' })
  })
})

describe('multi-repo lock and mobile force', () => {
  it('locks a member worktree against reparenting', async () => {
    const { service, store, workspaces } = createHarness(['a', 'b'])
    await service.create({ name: 'Lock', members: [{ repoId: 'a' }, { repoId: 'b' }] })
    const settled = await settle(workspaces)
    const worktreeId = settled.multiRepo!.members[0].worktreeId!
    expect(() => assertWorktreeNotMultiRepoMember(store, worktreeId)).toThrow(
      MultiRepoWorkspaceError
    )
    expect(() => assertWorktreeNotMultiRepoMember(store, 'other::/x')).not.toThrow()
  })

  it('rejects a blank workspace name before creating the system group', async () => {
    const { service, port } = createHarness(['a', 'b'])

    await expect(
      service.create({ name: '   ', members: [{ repoId: 'a' }, { repoId: 'b' }] })
    ).rejects.toMatchObject({ code: 'multi_repo_root_unavailable' })
    expect(port.createProjectGroup).not.toHaveBeenCalled()
  })

  it.each([
    ['forceMemberIds', { forceMemberIds: ['m'] }],
    ['allowFailedArchiveHookMemberIds', { allowFailedArchiveHookMemberIds: ['m'] }],
    ['runHooks false', { runHooks: false }]
  ])('refuses %s from a paired phone', async (_label, overrides) => {
    const method = MULTI_REPO_WORKSPACE_METHODS.find(
      (entry) => entry.name === 'multiRepoWorkspace.delete'
    )!
    await expect(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only pairedDeviceId and the params are read before the refusal.
      method.handler({ folderWorkspaceId: 'ws', ...overrides }, {
        pairedDeviceId: 'phone'
      } as never)
    ).rejects.toMatchObject({ code: 'multi_repo_force_not_allowed' })
  })

  it('refuses force from a paired phone', async () => {
    const method = MULTI_REPO_WORKSPACE_METHODS.find(
      (entry) => entry.name === 'multiRepoWorkspace.delete'
    )!
    await expect(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only pairedDeviceId and the params are read before the refusal.
      method.handler({ folderWorkspaceId: 'ws', forceMemberIds: ['m'] }, {
        pairedDeviceId: 'phone'
      } as never)
    ).rejects.toMatchObject({ code: 'multi_repo_force_not_allowed' })
  })
})
