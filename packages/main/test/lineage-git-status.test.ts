import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { WorkspaceKey } from '../../../src/shared/folder-workspace-types'
import type { WorkspaceLineage } from '../../../src/shared/worktree/lineage-types'
import type { GitStatusResult } from '../../../src/shared/git-status-types'
import {
  getLineageStatus,
  commitLineageProject
} from '../../../src/main/lineage/lineage-git-status-service'
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

describe('lineage-git-status', () => {
  let store: MockStore
  let tempRoot: string

  beforeEach(() => {
    store = new MockStore()
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-git-status-test-'))
  })

  it('collects child worktrees status concurrently under limit', async () => {
    const parentWorkspaceKey = 'folder:control-tower'
    const totalWorktrees = 14

    let inFlight = 0
    let maxInFlight = 0

    // Mock gitStatusFn with 15ms artificial delay to check concurrency
    const gitStatusFn = async (_worktreePath: string): Promise<GitStatusResult> => {
      inFlight++
      if (inFlight > maxInFlight) {
        maxInFlight = inFlight
      }
      await new Promise((resolve) => setTimeout(resolve, 15))
      inFlight--
      return {
        branch: 'test-branch',
        entries: [],
        conflictOperation: 'unknown'
      }
    }

    // Create 14 dummy worktrees on disk and register in store
    const existingPaths = new Map<string, string>()
    for (let i = 0; i < totalWorktrees; i++) {
      const wtDir = path.join(tempRoot, `repo-${i % 3}`, `feat-${i}`)
      fs.mkdirSync(wtDir, { recursive: true })
      existingPaths.set(`repo-${i % 3}::${wtDir}`, wtDir)

      const childKey: WorkspaceKey = `worktree:repo-${i % 3}::${wtDir}`
      store.setWorkspaceLineage({
        childWorkspaceKey: childKey,
        parentWorkspaceKey: parentWorkspaceKey,
        childInstanceId: `inst-${i}`,
        parentInstanceId: null,
        origin: 'cli',
        capture: { source: 'cwd-context', confidence: 'inferred' },
        createdAt: Date.now()
      })
    }

    const payload = await getLineageStatus(store, parentWorkspaceKey, {
      gitStatusFn,
      concurrencyLimit: 6
    })

    expect(payload.status).toBe(200)
    expect(maxInFlight).toBeLessThanOrEqual(6)
    expect(maxInFlight).toBeGreaterThan(1)

    // Verify all 14 worktrees were collected
    let count = 0
    for (const project of Object.values(payload.projects)) {
      count += project.worktrees.length
    }
    expect(count).toBe(14)
  })

  it('groups payload by project repository', async () => {
    const parentWorkspaceKey = 'folder:control-tower'

    // Create worktrees for two projects: loans-bff and auth-service
    const loansDir1 = path.join(tempRoot, 'loans-bff', 'feat-1')
    const loansDir2 = path.join(tempRoot, 'loans-bff', 'feat-2')
    const authDir = path.join(tempRoot, 'auth-service', 'fix-token')

    fs.mkdirSync(loansDir1, { recursive: true })
    fs.mkdirSync(loansDir2, { recursive: true })
    fs.mkdirSync(authDir, { recursive: true })

    store.setWorkspaceLineage({
      childWorkspaceKey: `worktree:loans-bff::${loansDir1}`,
      parentWorkspaceKey: parentWorkspaceKey,
      childInstanceId: 'inst-1',
      parentInstanceId: null,
      origin: 'cli',
      capture: { source: 'cwd-context', confidence: 'inferred' },
      createdAt: Date.now()
    })
    store.setWorkspaceLineage({
      childWorkspaceKey: `worktree:loans-bff::${loansDir2}`,
      parentWorkspaceKey: parentWorkspaceKey,
      childInstanceId: 'inst-2',
      parentInstanceId: null,
      origin: 'cli',
      capture: { source: 'cwd-context', confidence: 'inferred' },
      createdAt: Date.now()
    })
    store.setWorkspaceLineage({
      childWorkspaceKey: `worktree:auth-service::${authDir}`,
      parentWorkspaceKey: parentWorkspaceKey,
      childInstanceId: 'inst-3',
      parentInstanceId: null,
      origin: 'cli',
      capture: { source: 'cwd-context', confidence: 'inferred' },
      createdAt: Date.now()
    })

    const gitStatusFn = async (worktreePath: string): Promise<GitStatusResult> => {
      if (worktreePath.includes('loans-bff/feat-1')) {
        return {
          branch: 'feat-1',
          entries: [
            { path: 'src/loans.ts', status: 'modified', area: 'unstaged' },
            { path: 'README.md', status: 'untracked', area: 'untracked' }
          ],
          conflictOperation: 'unknown'
        }
      }
      if (worktreePath.includes('auth-service')) {
        return {
          branch: 'fix-token',
          entries: [{ path: 'src/jwt.ts', status: 'modified', area: 'unstaged' }],
          conflictOperation: 'unknown'
        }
      }
      return {
        branch: 'feat-2',
        entries: [],
        conflictOperation: 'unknown'
      }
    }

    const payload = await getLineageStatus(store, parentWorkspaceKey, {
      gitStatusFn
    })

    expect(payload.parentKey).toBe(parentWorkspaceKey)
    expect(payload.totalDirtyFiles).toBe(3)

    // Grouped primarily by repoName
    expect(payload.projects['loans-bff']).toBeDefined()
    expect(payload.projects['loans-bff'].repoName).toBe('loans-bff')
    expect(payload.projects['loans-bff'].worktrees).toHaveLength(2)

    const loansFeat1 = payload.projects['loans-bff'].worktrees.find((w) => w.branch === 'feat-1')
    expect(loansFeat1).toBeDefined()
    expect(loansFeat1?.dirtyFiles).toHaveLength(2)

    expect(payload.projects['auth-service']).toBeDefined()
    expect(payload.projects['auth-service'].repoName).toBe('auth-service')
    expect(payload.projects['auth-service'].worktrees).toHaveLength(1)
    expect(payload.projects['auth-service'].worktrees[0].branch).toBe('fix-token')
    expect(payload.projects['auth-service'].worktrees[0].dirtyFiles).toHaveLength(1)
  })

  it('omits deleted child worktree', async () => {
    const parentWorkspaceKey = 'folder:control-tower'

    const existingDir = path.join(tempRoot, 'active-repo', 'feature-live')
    const deletedDir = path.join(tempRoot, 'active-repo', 'feature-deleted')

    fs.mkdirSync(existingDir, { recursive: true })
    // deletedDir is NOT created on disk

    store.setWorkspaceLineage({
      childWorkspaceKey: `worktree:active-repo::${existingDir}`,
      parentWorkspaceKey: parentWorkspaceKey,
      childInstanceId: 'inst-live',
      parentInstanceId: null,
      origin: 'cli',
      capture: { source: 'cwd-context', confidence: 'inferred' },
      createdAt: Date.now()
    })
    store.setWorkspaceLineage({
      childWorkspaceKey: `worktree:active-repo::${deletedDir}`,
      parentWorkspaceKey: parentWorkspaceKey,
      childInstanceId: 'inst-deleted',
      parentInstanceId: null,
      origin: 'cli',
      capture: { source: 'cwd-context', confidence: 'inferred' },
      createdAt: Date.now()
    })

    const gitStatusFn = async (_worktreePath: string): Promise<GitStatusResult> => ({
      branch: 'feature-live',
      entries: [],
      conflictOperation: 'unknown'
    })

    const payload = await getLineageStatus(store, parentWorkspaceKey, {
      gitStatusFn
    })

    expect(payload.status).toBe(200)
    expect(payload.projects['active-repo']).toBeDefined()
    expect(payload.projects['active-repo'].worktrees).toHaveLength(1)
    expect(payload.projects['active-repo'].worktrees[0].worktreePath).toBe(
      path.resolve(existingDir)
    )
  })

  it('validates empty commit message in commitLineageProject (C11)', async () => {
    const resEmpty = await commitLineageProject(store, {
      worktreePath: tempRoot,
      message: ''
    })
    expect(resEmpty.status).toBe(400)
    expect(resEmpty.success).toBe(false)
    expect(resEmpty.error).toBe('Commit message is required')

    const resWhitespace = await commitLineageProject(store, {
      worktreePath: tempRoot,
      message: '   \n  '
    })
    expect(resWhitespace.status).toBe(400)
    expect(resWhitespace.success).toBe(false)
  })
})
