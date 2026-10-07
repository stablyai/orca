import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { WorkspaceLineage } from '../../../src/shared/worktree/lineage-types'
import {
  setActiveLineageContext,
  clearActiveLineageContext
} from '../../../src/main/lineage/pty-env-injector'
import type { LineageStoreContract } from '../../../src/main/lineage/workspace-lineage-service'

type IpcResponse = {
  status?: number
  registered?: boolean
  lineageEntry?: { parentWorkspaceKey: string; childWorkspaceKey: string }
  [key: string]: unknown
}
type IpcHandler = (_event: unknown, ...args: unknown[]) => Promise<IpcResponse>
const handlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
}))

import { registerLineageIpcHandlers } from '../../../src/main/ipc/lineage-ipc-handlers'

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

describe('workspace-ipc', () => {
  let store: MockStore

  beforeEach(() => {
    store = new MockStore()
    handlers.clear()
    clearActiveLineageContext()
    registerLineageIpcHandlers(store)
  })

  afterEach(() => {
    clearActiveLineageContext()
  })

  it('notifies custom worktree created', async () => {
    // 1. Setup active control tower session
    setActiveLineageContext({
      parentWorkspaceKey: 'folder:control-tower-prod',
      parentSessionId: 'sess-tower-prod'
    })

    // 2. Custom worktree outside ~/orca/workspaces/
    const customWorktreePath = '/custom/path/outside/workspaces/my-repo/custom-feature'

    const handler = handlers.get('workspace:notify-worktree-created')
    expect(handler).toBeDefined()

    const response = await handler!(
      {},
      {
        worktreePath: customWorktreePath,
        repoName: 'my-repo',
        branch: 'custom-feature'
      }
    )

    expect(response.status).toBe(200)
    expect(response.registered).toBe(true)
    expect(response.lineageEntry?.parentWorkspaceKey).toBe('folder:control-tower-prod')
    expect(response.lineageEntry?.childWorkspaceKey).toBe('worktree:my-repo:custom-feature')

    // 3. Verify in store
    const inStore = store.getWorkspaceLineage('worktree:my-repo:custom-feature')
    expect(inStore).toBeDefined()
    expect(inStore?.parentWorkspaceKey).toBe('folder:control-tower-prod')
  })

  it('handles workspace:notify-worktree-created with status 400 when missing worktreePath', async () => {
    setActiveLineageContext({
      parentWorkspaceKey: 'folder:tower',
      parentSessionId: 'sess-1'
    })

    const handler = handlers.get('workspace:notify-worktree-created')
    const response = await handler!(
      {},
      {
        worktreePath: ''
      }
    )

    expect(response.status).toBe(400)
    expect(response.registered).toBe(false)
    expect(response.error).toBeDefined()
  })

  it('handles workspace:notify-worktree-created with status 400 when no parent is active', async () => {
    clearActiveLineageContext()

    const handler = handlers.get('workspace:notify-worktree-created')
    const response = await handler!(
      {},
      {
        worktreePath: '/tmp/test-wt',
        repoName: 'repo-1'
      }
    )

    expect(response.status).toBe(400)
    expect(response.registered).toBe(false)
    expect(response.error).toContain('No active parent workspace found')
  })

  it('handles workspace:notify-worktree-created with status 500 on store failure', async () => {
    const brokenStore: LineageStoreContract = {
      getAllWorkspaceLineage: () => ({}),
      setWorkspaceLineage: () => {
        throw new Error('Disk write error')
      }
    }
    registerLineageIpcHandlers(brokenStore)

    setActiveLineageContext({
      parentWorkspaceKey: 'folder:tower',
      parentSessionId: 'sess-1'
    })

    const handler = handlers.get('workspace:notify-worktree-created')
    const response = await handler!(
      {},
      {
        worktreePath: '/tmp/test-wt',
        repoName: 'repo-1'
      }
    )

    expect(response.status).toBe(500)
    expect(response.registered).toBe(false)
    expect(response.error).toBe('Disk write error')
  })

  it('rejects attach-to-parent keys that are not workspace keys', async () => {
    const handler = handlers.get('workspace:attach-to-parent')
    const response = await handler!(
      {},
      { parentWorkspaceKey: 'parent', childWorkspaceKey: 'child' }
    )

    expect(response.status).toBe(400)
    expect(response.success).toBe(false)
  })

  it('handles workspace:attach-to-parent correctly', async () => {
    const handler = handlers.get('workspace:attach-to-parent')
    expect(handler).toBeDefined()

    const response = await handler!(
      {},
      {
        parentWorkspaceKey: 'folder:parent-abc',
        childWorkspaceKey: 'worktree:child-xyz'
      }
    )

    expect(response.status).toBe(200)
    expect(response.success).toBe(true)
    expect(response.lineageEntry?.parentWorkspaceKey).toBe('folder:parent-abc')
    expect(response.lineageEntry?.childWorkspaceKey).toBe('worktree:child-xyz')
  })
})
