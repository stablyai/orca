import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateWorktreeArgs } from '../../../../shared/worktree/create-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  assertAttachableParentWorkspace,
  recordWorkspaceLineageForCreatedWorktree
} from '../../worktree-remote'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'

const CHILD_ID = 'repo-1::/repos/child'
const PARENT_ID = 'repo-1::/repos/parent'
const CREATED_AT = 1_700_000_000_000

function createdWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: CHILD_ID,
    instanceId: 'child-instance',
    repoId: 'repo-1',
    hostId: 'local',
    projectId: 'project-1',
    path: '/repos/child',
    head: 'abc123',
    branch: 'refs/heads/child',
    isBare: false,
    isMainWorktree: false,
    displayName: 'child',
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
  }
}

function parentMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    instanceId: 'parent-instance',
    hostId: 'local',
    projectId: 'project-1',
    displayName: 'parent',
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
  }
}

function createStore(options: {
  metaById?: Record<string, WorktreeMeta>
  folderWorkspaceIds?: string[]
}) {
  const metaById = options.metaById ?? {}
  const folderWorkspaceIds = new Set(options.folderWorkspaceIds ?? [])
  return {
    getWorktreeMeta: vi.fn((id: string) => metaById[id]),
    getWorktreeMetaForHost: vi.fn(
      (_id: string, _hostId: ExecutionHostId): WorktreeMeta | undefined => undefined
    ),
    getFolderWorkspace: vi.fn((id: string) =>
      folderWorkspaceIds.has(id) ? { id, path: `/folders/${id}` } : undefined
    ),
    setWorktreeLineage: vi.fn((_target: HostWorktreeTarget, lineage: unknown) => lineage),
    setWorkspaceLineage: vi.fn((lineage: unknown) => lineage)
  }
}

function record(
  store: ReturnType<typeof createStore>,
  args: Partial<CreateWorktreeArgs>,
  worktree = createdWorktree(),
  noteLineage?: Parameters<typeof recordWorkspaceLineageForCreatedWorktree>[4]
) {
  return recordWorkspaceLineageForCreatedWorktree(
    store as never,
    args as CreateWorktreeArgs,
    worktree,
    CREATED_AT,
    noteLineage
  )
}

describe('recordWorkspaceLineageForCreatedWorktree', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('skips both lineage records when the parent is on another host', () => {
    const store = createStore({
      metaById: { [PARENT_ID]: parentMeta({ hostId: 'ssh:other-host' }) }
    })

    const result = record(store, { parentWorkspace: worktreeWorkspaceKey(PARENT_ID) })

    expect(store.setWorktreeLineage).not.toHaveBeenCalled()
    expect(result.lineage).toBeNull()
    expect(store.setWorkspaceLineage).not.toHaveBeenCalled()
    expect(result.workspaceLineage).toBeNull()
  })
  it('nests under the task parent a note names when no parent was picked', () => {
    const store = createStore({})
    const parent = {
      ...createdWorktree({ id: PARENT_ID, instanceId: 'parent-instance', path: '/repos/parent' }),
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: {
        path: '/repos/parent',
        head: 'abc123',
        branch: 'refs/heads/parent',
        isBare: false,
        isMainWorktree: false
      }
    }

    const result = record(store, { comment: 'review task_7Kq2' }, createdWorktree(), {
      kind: 'lineage',
      parent: {
        type: 'worktree',
        workspaceKey: worktreeWorkspaceKey(PARENT_ID),
        worktree: parent,
        instanceId: 'parent-instance'
      },
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'inferred' },
      taskId: 'task_7Kq2'
    })

    expect(result.lineage?.parentWorktreeId).toBe(PARENT_ID)
    expect(result.workspaceLineage?.parentWorkspaceKey).toBe(worktreeWorkspaceKey(PARENT_ID))
  })
})

describe('assertAttachableParentWorkspace', () => {
  const childKey = worktreeWorkspaceKey(CHILD_ID)

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function assertParent(
    store: ReturnType<typeof createStore>,
    parentWorkspace: CreateWorktreeArgs['parentWorkspace']
  ) {
    assertAttachableParentWorkspace(store as never, parentWorkspace, childKey)
  }

  // Composer parent selection can go stale; nesting must not block creation.

  it('rejects a self-referential parent', () => {
    const store = createStore({ metaById: { [CHILD_ID]: parentMeta() } })

    expect(() => assertParent(store, childKey)).toThrow(/cannot be attached to itself/)
  })

  it('rejects a malformed parent key', () => {
    const store = createStore({})

    expect(() => assertParent(store, 'not-a-workspace-key' as never)).toThrow(
      /Invalid parent workspace/
    )
  })
})
