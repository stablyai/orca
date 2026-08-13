import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type {
  CreateWorktreeArgs,
  Repo,
  Worktree,
  WorktreeLineage,
  WorktreeMeta,
  WorkspaceLineage
} from '../../shared/types'
import {
  recordLineageForCreatedWorktree,
  validateExplicitWorktreeParentBeforeCreate
} from './worktree-remote'

const LOCAL_REPO: Repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'Repo',
  badgeColor: 'blue',
  addedAt: 1
}
const LOCAL_PROJECT_ID = 'repo:repo-1'

afterEach(() => vi.restoreAllMocks())

function makeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  } as WorktreeMeta
}

function makeWorktree(
  id: string,
  instanceId: string,
  projectId = LOCAL_PROJECT_ID,
  hostId: Worktree['hostId'] = 'local'
): Worktree {
  const path = id.slice(id.indexOf('::') + 2)
  return {
    id,
    instanceId,
    repoId: id.slice(0, id.indexOf('::')),
    projectId,
    hostId,
    path,
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function makeStore(args: {
  metaById: Record<string, WorktreeMeta>
  lineageById?: Record<string, WorktreeLineage>
  repo?: Repo
  folderWorkspaceIds?: string[]
}) {
  const repo = args.repo ?? LOCAL_REPO
  const lineageById = args.lineageById ?? {}
  const setWorktreeLineage = vi.fn((_worktreeId: string, lineage: WorktreeLineage) => lineage)
  const setWorkspaceLineage = vi.fn((lineage: WorkspaceLineage) => lineage)
  const store = {
    getWorktreeMeta: (worktreeId: string) => args.metaById[worktreeId],
    getWorktreeLineage: (worktreeId: string) => lineageById[worktreeId],
    getProjectHostSetups: () => [
      {
        id: repo.id,
        projectId: LOCAL_PROJECT_ID,
        hostId: repo.connectionId ? `ssh:${repo.connectionId}` : 'local',
        repoId: repo.id,
        path: repo.path,
        displayName: repo.displayName,
        setupState: 'ready',
        setupMethod: 'legacy-repo',
        createdAt: 1,
        updatedAt: 1
      }
    ],
    getFolderWorkspace: (id: string) =>
      args.folderWorkspaceIds?.includes(id) ? { id } : undefined,
    setWorktreeLineage,
    setWorkspaceLineage
  } as unknown as Store
  return { store, setWorktreeLineage, setWorkspaceLineage }
}

type ParentRaceState = {
  metaById: Record<string, WorktreeMeta>
  lineageById: Record<string, WorktreeLineage>
}

const POST_CREATE_PARENT_RACES: {
  name: string
  activePaths: string[]
  mutate: (state: ParentRaceState, parentId: string, childId: string) => void
}[] = [
  {
    name: 'same-path replacement',
    activePaths: ['/workspace/parent', '/workspace/child'],
    mutate: (state, parentId) => {
      state.metaById[parentId] = makeMeta({
        instanceId: 'replacement-instance',
        projectId: LOCAL_PROJECT_ID,
        hostId: 'local'
      })
    }
  },
  {
    name: 'archival',
    activePaths: ['/workspace/parent', '/workspace/child'],
    mutate: (state, parentId) => {
      state.metaById[parentId] = makeMeta({
        instanceId: 'parent-instance',
        projectId: LOCAL_PROJECT_ID,
        hostId: 'local',
        isArchived: true
      })
    }
  },
  {
    name: 'project boundary change',
    activePaths: ['/workspace/parent', '/workspace/child'],
    mutate: (state, parentId) => {
      state.metaById[parentId] = makeMeta({
        instanceId: 'parent-instance',
        projectId: 'repo:other',
        hostId: 'local'
      })
    }
  },
  {
    name: 'lineage cycle insertion',
    activePaths: ['/workspace/parent', '/workspace/child'],
    mutate: (state, parentId, childId) => {
      state.metaById[childId] = makeMeta({
        instanceId: 'child-instance',
        projectId: LOCAL_PROJECT_ID,
        hostId: 'local'
      })
      state.lineageById[parentId] = {
        worktreeId: parentId,
        worktreeInstanceId: 'parent-instance',
        parentWorktreeId: childId,
        parentWorktreeInstanceId: 'child-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }
  },
  {
    name: 'removal from the Git worktree listing',
    activePaths: ['/workspace/child'],
    mutate: () => undefined
  }
]

describe('explicit worktree parent creation lineage', () => {
  it('validates and records both local lineage projections', () => {
    const parentId = 'repo-1::/workspace/parent'
    const childId = 'repo-1::/workspace/child'
    const { store, setWorktreeLineage, setWorkspaceLineage } = makeStore({
      metaById: {
        [parentId]: makeMeta({
          instanceId: 'parent-instance',
          projectId: LOCAL_PROJECT_ID,
          hostId: 'local'
        })
      }
    })

    const parent = validateExplicitWorktreeParentBeforeCreate(
      store,
      LOCAL_REPO,
      parentId,
      childId,
      ['/workspace/repo', '/workspace/parent']
    )
    const result = recordLineageForCreatedWorktree(
      store,
      { repoId: LOCAL_REPO.id, name: 'child', parentWorktreeId: parentId },
      makeWorktree(childId, 'child-instance'),
      123,
      parent,
      LOCAL_REPO,
      ['/workspace/repo', '/workspace/parent', '/workspace/child']
    )

    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        capture: { source: 'manual-action', confidence: 'explicit' }
      })
    )
    expect(setWorkspaceLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        childWorkspaceKey: `worktree:${childId}`,
        childInstanceId: 'child-instance',
        parentWorkspaceKey: `worktree:${parentId}`,
        parentInstanceId: 'parent-instance'
      })
    )
    expect(result).toEqual({
      lineage: setWorktreeLineage.mock.results[0]?.value,
      workspaceLineage: setWorkspaceLineage.mock.results[0]?.value
    })
  })

  it.each(POST_CREATE_PARENT_RACES)(
    'leaves the created worktree at root after a parent $name race',
    ({ activePaths, mutate }) => {
      const parentId = 'repo-1::/workspace/parent'
      const childId = 'repo-1::/workspace/child'
      const state: ParentRaceState = {
        metaById: {
          [parentId]: makeMeta({
            instanceId: 'parent-instance',
            projectId: LOCAL_PROJECT_ID,
            hostId: 'local'
          })
        },
        lineageById: {}
      }
      const { store, setWorktreeLineage, setWorkspaceLineage } = makeStore(state)
      const parent = validateExplicitWorktreeParentBeforeCreate(
        store,
        LOCAL_REPO,
        parentId,
        childId,
        ['/workspace/parent']
      )
      mutate(state, parentId, childId)
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      const result = recordLineageForCreatedWorktree(
        store,
        { repoId: LOCAL_REPO.id, name: 'child', parentWorktreeId: parentId },
        makeWorktree(childId, 'child-instance'),
        123,
        parent,
        LOCAL_REPO,
        activePaths
      )

      expect(setWorktreeLineage).not.toHaveBeenCalled()
      expect(setWorkspaceLineage).not.toHaveBeenCalled()
      expect(result).toEqual({
        lineage: null,
        workspaceLineage: null,
        warning: expect.stringContaining('left at the root')
      })
    }
  )

  it('accepts a parent on the same direct SSH host and project', () => {
    const repo: Repo = { ...LOCAL_REPO, connectionId: 'conn-1' }
    const parentId = 'repo-1::/remote/parent'
    const childId = 'repo-1::/remote/child'
    const { store } = makeStore({
      repo,
      metaById: {
        [parentId]: makeMeta({
          instanceId: 'parent-instance',
          projectId: LOCAL_PROJECT_ID,
          hostId: 'ssh:conn-1'
        })
      }
    })

    expect(
      validateExplicitWorktreeParentBeforeCreate(store, repo, parentId, childId, ['/remote/parent'])
    ).toEqual({ worktreeId: parentId, instanceId: 'parent-instance' })
  })

  it('accepts legacy parent metadata without projected ownership', () => {
    const parentId = 'repo-1::/workspace/parent'
    const { store } = makeStore({
      metaById: {
        [parentId]: makeMeta({ instanceId: 'parent-instance' })
      }
    })

    expect(
      validateExplicitWorktreeParentBeforeCreate(store, LOCAL_REPO, parentId, 'child', [
        '/workspace/parent'
      ])
    ).toEqual({ worktreeId: parentId, instanceId: 'parent-instance' })
  })

  it.each([
    {
      name: 'missing instance identity',
      meta: makeMeta({ projectId: LOCAL_PROJECT_ID, hostId: 'local' }),
      activePaths: ['/workspace/parent'],
      error: 'Parent worktree instance identity was unavailable.'
    },
    {
      name: 'archived parent',
      meta: makeMeta({
        instanceId: 'parent-instance',
        projectId: LOCAL_PROJECT_ID,
        hostId: 'local',
        isArchived: true
      }),
      activePaths: ['/workspace/parent'],
      error: 'Archived worktrees cannot be used as parents.'
    },
    {
      name: 'inactive parent',
      meta: makeMeta({
        instanceId: 'parent-instance',
        projectId: LOCAL_PROJECT_ID,
        hostId: 'local'
      }),
      activePaths: ['/workspace/repo'],
      error: 'Parent worktree is no longer active.'
    },
    {
      name: 'different project',
      meta: makeMeta({
        instanceId: 'parent-instance',
        projectId: 'repo:other',
        hostId: 'local'
      }),
      activePaths: ['/workspace/parent'],
      error: 'same repository, execution host, and project'
    },
    {
      name: 'different execution host',
      meta: makeMeta({
        instanceId: 'parent-instance',
        projectId: LOCAL_PROJECT_ID,
        hostId: 'ssh:other'
      }),
      activePaths: ['/workspace/parent'],
      error: 'same repository, execution host, and project'
    }
  ])('rejects a $name before creation', ({ meta, activePaths, error }) => {
    const parentId = 'repo-1::/workspace/parent'
    const { store } = makeStore({ metaById: { [parentId]: meta } })

    expect(() =>
      validateExplicitWorktreeParentBeforeCreate(
        store,
        LOCAL_REPO,
        parentId,
        'repo-1::/workspace/child',
        activePaths
      )
    ).toThrow(error)
  })

  it('rejects a parent whose valid lineage would create a cycle', () => {
    const parentId = 'repo-1::/workspace/parent'
    const childId = 'repo-1::/workspace/child'
    const { store } = makeStore({
      metaById: {
        [parentId]: makeMeta({
          instanceId: 'parent-instance',
          projectId: LOCAL_PROJECT_ID,
          hostId: 'local'
        }),
        [childId]: makeMeta({
          instanceId: 'stale-child-instance',
          projectId: LOCAL_PROJECT_ID,
          hostId: 'local'
        })
      },
      lineageById: {
        [parentId]: {
          worktreeId: parentId,
          worktreeInstanceId: 'parent-instance',
          parentWorktreeId: childId,
          parentWorktreeInstanceId: 'stale-child-instance',
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 1
        }
      }
    })

    expect(() =>
      validateExplicitWorktreeParentBeforeCreate(store, LOCAL_REPO, parentId, childId, [
        '/workspace/parent'
      ])
    ).toThrow('Parent worktree would create a lineage cycle.')
  })

  it('keeps folder-parent workspace lineage when no explicit worktree parent is selected', () => {
    const childId = 'repo-1::/workspace/child'
    const { store, setWorktreeLineage, setWorkspaceLineage } = makeStore({
      metaById: {},
      folderWorkspaceIds: ['folder-parent']
    })
    const args: CreateWorktreeArgs = {
      repoId: LOCAL_REPO.id,
      name: 'child',
      parentWorkspace: 'folder:folder-parent'
    }

    const result = recordLineageForCreatedWorktree(
      store,
      args,
      makeWorktree(childId, 'child-instance'),
      123,
      null,
      LOCAL_REPO,
      []
    )

    expect(setWorktreeLineage).not.toHaveBeenCalled()
    expect(setWorkspaceLineage).toHaveBeenCalledWith(
      expect.objectContaining({ parentWorkspaceKey: 'folder:folder-parent' })
    )
    expect(result.lineage).toBeNull()
  })

  it('lets an explicit worktree parent override inherited folder-parent context', () => {
    const parentId = 'repo-1::/workspace/parent'
    const childId = 'repo-1::/workspace/child'
    const { store, setWorkspaceLineage } = makeStore({
      metaById: {
        [parentId]: makeMeta({
          instanceId: 'parent-instance',
          projectId: LOCAL_PROJECT_ID,
          hostId: 'local'
        })
      },
      folderWorkspaceIds: ['folder-parent']
    })

    recordLineageForCreatedWorktree(
      store,
      {
        repoId: LOCAL_REPO.id,
        name: 'child',
        parentWorktreeId: parentId,
        parentWorkspace: 'folder:folder-parent'
      },
      makeWorktree(childId, 'child-instance'),
      123,
      { worktreeId: parentId, instanceId: 'parent-instance' },
      LOCAL_REPO,
      ['/workspace/parent', '/workspace/child']
    )

    expect(setWorkspaceLineage).toHaveBeenCalledWith(
      expect.objectContaining({ parentWorkspaceKey: `worktree:${parentId}` })
    )
  })
})
