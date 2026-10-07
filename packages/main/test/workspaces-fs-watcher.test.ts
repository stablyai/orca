import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { WorkspaceLineage } from '../../../src/shared/worktree/lineage-types'
import {
  startWorkspacesFsWatcher,
  stopWorkspacesFsWatcher,
  handleDiscoveredWorktree
} from '../../../src/main/lineage/workspaces-fs-watcher'
import {
  setActiveLineageContext,
  clearActiveLineageContext
} from '../../../src/main/lineage/pty-env-injector'
import type { LineageStoreContract } from '../../../src/main/lineage/workspace-lineage-service'

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

describe('workspaces-fs-watcher', () => {
  let tempDir: string
  let store: MockStore

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-wt-test-'))
    store = new MockStore()
    clearActiveLineageContext()
  })

  afterEach(() => {
    stopWorkspacesFsWatcher()
    clearActiveLineageContext()
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('detects new worktree and links to active session', async () => {
    // 1. Setup active session in Tower
    setActiveLineageContext({
      parentWorkspaceKey: 'folder:control-tower-main',
      parentSessionId: 'sess-tower-1'
    })

    // 2. Start watcher on temp test workspace root with short debounce
    const discoveredPromise = new Promise<string>((resolve) => {
      startWorkspacesFsWatcher({
        watchRoot: tempDir,
        debounceMs: 50,
        store,
        onDiscovered: (info) => {
          resolve(info.childKey)
        }
      })
    })

    // 3. Create worktree directory and .git file
    const wtDir = path.join(tempDir, 'loans.loan-bff', 'test-feat')
    fs.mkdirSync(wtDir, { recursive: true })
    const gitFilePath = path.join(wtDir, '.git')
    fs.writeFileSync(gitFilePath, 'gitdir: /repos/loans/.git/worktrees/test-feat\n')

    // 4. Wait for FS event
    const discoveredKey = await Promise.race([
      discoveredPromise,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Watcher timed out')), 5000)
      )
    ])

    expect(discoveredKey).toBe('worktree:loans.loan-bff:test-feat')

    // 5. Verify store contains child registered to active parent
    const lineage = store.getWorkspaceLineage('worktree:loans.loan-bff:test-feat')
    expect(lineage).toBeDefined()
    expect(lineage?.parentWorkspaceKey).toBe('folder:control-tower-main')
  })

  it('handleDiscoveredWorktree directly registers child to active session', () => {
    setActiveLineageContext({
      parentWorkspaceKey: 'folder:tower-direct',
      parentSessionId: 'session-direct'
    })

    const wtDir = path.join(tempDir, 'payments-api', 'hotfix-1')
    fs.mkdirSync(wtDir, { recursive: true })
    fs.writeFileSync(path.join(wtDir, '.git'), 'gitdir: /repos/payments/.git/worktrees/hotfix-1\n')

    const registered = handleDiscoveredWorktree(wtDir, store, { watchRoot: tempDir })
    expect(registered).toBe(true)

    const lineage = store.getWorkspaceLineage('worktree:payments-api:hotfix-1')
    expect(lineage).toBeDefined()
    expect(lineage?.parentWorkspaceKey).toBe('folder:tower-direct')
  })

  it('ignores worktree discovery if no session is active', () => {
    clearActiveLineageContext()

    const wtDir = path.join(tempDir, 'repo', 'feature')
    fs.mkdirSync(wtDir, { recursive: true })
    fs.writeFileSync(path.join(wtDir, '.git'), 'gitdir: /repos/repo/.git/worktrees/feature\n')

    const registered = handleDiscoveredWorktree(wtDir, store, { watchRoot: tempDir })
    expect(registered).toBe(false)
    expect(Object.keys(store.getAllWorkspaceLineage())).toHaveLength(0)
  })
})
