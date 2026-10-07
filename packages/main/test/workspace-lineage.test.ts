import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { WorkspaceLineage } from '../../../src/shared/worktree/lineage-types'
import {
  attachWorkspaceToParent,
  notifyWorktreeCreated,
  getLineageChildrenForParent,
  type LineageStoreContract
} from '../../../src/main/lineage/workspace-lineage-service'
import {
  clearActiveLineageContext
} from '../../../src/main/lineage/pty-env-injector'

class MockStore implements LineageStoreContract {
  state: {
    workspaceLineageByChildKey: Record<string, WorkspaceLineage>
  } = {
    workspaceLineageByChildKey: {}
  }

  getAllWorkspaceLineage(): Record<string, WorkspaceLineage> {
    return this.state.workspaceLineageByChildKey
  }

  getWorkspaceLineage(childKey: string): WorkspaceLineage | undefined {
    return this.state.workspaceLineageByChildKey[childKey]
  }

  setWorkspaceLineage(lineage: WorkspaceLineage): WorkspaceLineage {
    this.state.workspaceLineageByChildKey[lineage.childWorkspaceKey] = lineage
    return lineage
  }

  getState() {
    return this.state
  }
}

describe('workspace-lineage', () => {
  let store: MockStore

  beforeEach(() => {
    store = new MockStore()
    clearActiveLineageContext()
  })

  afterEach(() => {
    clearActiveLineageContext()
  })

  it('registers child workspace with parent key', () => {
    // 1. Simulate agent running with ORCA_PARENT_WORKSPACE_KEY
    process.env.ORCA_PARENT_WORKSPACE_KEY = 'folder:control-tower'
    process.env.ORCA_PARENT_SESSION_ID = 'session-123'

    const result = notifyWorktreeCreated(store, {
      worktreePath: '/Users/u004767/orca/workspaces/billing-service/feature-x',
      repoName: 'billing-service',
      branch: 'feature-x'
    })

    expect(result.status).toBe(200)
    expect(result.registered).toBe(true)
    expect(result.lineageEntry?.parentWorkspaceKey).toBe('folder:control-tower')
    expect(result.lineageEntry?.childWorkspaceKey).toBe('worktree:billing-service:feature-x')

    const inStore = store.getWorkspaceLineage('worktree:billing-service:feature-x')
    expect(inStore).toBeDefined()
    expect(inStore?.parentWorkspaceKey).toBe('folder:control-tower')
  })

  it('idempotency: registering same child workspace twice preserves existing parent', () => {
    process.env.ORCA_PARENT_WORKSPACE_KEY = 'folder:tower-1'

    const first = notifyWorktreeCreated(store, {
      worktreePath: '/Users/u004767/orca/workspaces/auth/feat-auth',
      repoName: 'auth',
      branch: 'feat-auth'
    })
    expect(first.status).toBe(200)

    const initialCreatedAt = first.lineageEntry?.createdAt

    // Call again with same child
    const second = notifyWorktreeCreated(store, {
      worktreePath: '/Users/u004767/orca/workspaces/auth/feat-auth',
      repoName: 'auth',
      branch: 'feat-auth'
    })

    expect(second.status).toBe(200)
    expect(second.lineageEntry?.createdAt).toBe(initialCreatedAt)
    expect(second.lineageEntry?.parentWorkspaceKey).toBe('folder:tower-1')
  })

  it('attachWorkspaceToParent handles 200, 400, and 500 status codes', () => {
    // 200 OK
    const res200 = attachWorkspaceToParent(store, {
      parentWorkspaceKey: 'folder:parent-1',
      childWorkspaceKey: 'worktree:child-1'
    })
    expect(res200.status).toBe(200)
    expect(res200.success).toBe(true)
    expect(res200.lineageEntry?.parentWorkspaceKey).toBe('folder:parent-1')

    // 400 Bad Request: missing parameters
    const res400 = attachWorkspaceToParent(store, {
      parentWorkspaceKey: '',
      childWorkspaceKey: 'worktree:child-1'
    })
    expect(res400.status).toBe(400)
    expect(res400.success).toBe(false)
    expect(res400.error).toBeDefined()

    // 500 Internal Error: broken store
    const brokenStore: LineageStoreContract = {
      getAllWorkspaceLineage: () => {
        throw new Error('Database failure')
      }
    }
    const res500 = attachWorkspaceToParent(brokenStore, {
      parentWorkspaceKey: 'folder:parent-1',
      childWorkspaceKey: 'worktree:child-1'
    })
    expect(res500.status).toBe(500)
    expect(res500.success).toBe(false)
  })

  it('retrieves child worktrees for parent workspace', () => {
    store.setWorkspaceLineage({
      childWorkspaceKey: 'worktree:repo1:b1',
      parentWorkspaceKey: 'folder:tower',
      childInstanceId: 'inst-1',
      parentInstanceId: null,
      origin: 'cli',
      capture: { source: 'cwd-context', confidence: 'inferred' },
      createdAt: Date.now()
    })
    store.setWorkspaceLineage({
      childWorkspaceKey: 'worktree:repo2:b2',
      parentWorkspaceKey: 'folder:tower',
      childInstanceId: 'inst-2',
      parentInstanceId: null,
      origin: 'cli',
      capture: { source: 'cwd-context', confidence: 'inferred' },
      createdAt: Date.now()
    })
    store.setWorkspaceLineage({
      childWorkspaceKey: 'worktree:other:b3',
      parentWorkspaceKey: 'folder:other-parent',
      childInstanceId: 'inst-3',
      parentInstanceId: null,
      origin: 'cli',
      capture: { source: 'cwd-context', confidence: 'inferred' },
      createdAt: Date.now()
    })

    const children = getLineageChildrenForParent(store, 'folder:tower')
    expect(children).toHaveLength(2)
    expect(children.map((c) => c.childWorkspaceKey)).toEqual([
      'worktree:repo1:b1',
      'worktree:repo2:b2'
    ])
  })
})
