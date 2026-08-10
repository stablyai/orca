import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo, WorktreeLineage, WorkspaceLineage } from '../shared/types'
import { worktreeWorkspaceKey } from '../shared/workspace-scope'
import { listWorktreesStrict } from './git/worktree'
import { pruneLineageForMissingRepoWorktrees } from './worktree-lineage-pruning'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('worktree lineage pruning with real Git', () => {
  it('does not apply pre-create discovery to lineage recorded after a real worktree add', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-lineage-race-')))
    tempRoots.push(root)
    const repoPath = path.join(root, 'repo')
    const childPath = path.join(root, 'child')
    git(root, ['init', '--quiet', repoPath])
    git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    git(repoPath, ['config', 'user.email', 'test@example.com'])
    git(repoPath, ['config', 'user.name', 'Test User'])
    git(repoPath, ['commit', '--allow-empty', '--quiet', '-m', 'initial'])

    const repo: Repo = {
      id: 'repo-real',
      path: repoPath,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1
    }
    const childId = `${repo.id}::${childPath}`
    const parentId = `${repo.id}::${repoPath}`
    const childWorkspaceKey = worktreeWorkspaceKey(childId)
    const scanStartedAt = 1_700_000_000_000
    const worktreeLineageById: Record<string, WorktreeLineage> = {}
    const workspaceLineageByChildKey: Record<string, WorkspaceLineage> = {}
    let lineageRevision = scanStartedAt
    const removeWorktreeLineage = vi.fn((id: string) => delete worktreeLineageById[id])
    const removeWorkspaceLineage = vi.fn((key: string) => delete workspaceLineageByChildKey[key])
    const store = {
      getRepos: () => [repo],
      getLineageRevision: () => lineageRevision,
      getAllWorktreeLineage: () => worktreeLineageById,
      getAllWorkspaceLineage: () => workspaceLineageByChildKey,
      getWorktreeMeta: () => undefined,
      removeWorktreeLineage,
      removeWorkspaceLineage,
      setWorktreeLineage: (id: string, lineage: WorktreeLineage) => {
        worktreeLineageById[id] = lineage
        lineageRevision += 1
      },
      setWorkspaceLineage: (lineage: WorkspaceLineage) => {
        workspaceLineageByChildKey[lineage.childWorkspaceKey] = lineage
        lineageRevision += 1
      },
      setWorktreeMeta: vi.fn()
    }

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(scanStartedAt)
    let releasePrune = (): void => {}
    const pruneReleased = new Promise<void>((resolve) => {
      releasePrune = resolve
    })
    let reportDiscovery = (_worktrees: Awaited<ReturnType<typeof listWorktreesStrict>>): void => {}
    const discovery = new Promise<Awaited<ReturnType<typeof listWorktreesStrict>>>((resolve) => {
      reportDiscovery = resolve
    })
    const scan = (async () => {
      const scanLineageRevision = store.getLineageRevision()
      const worktrees = await listWorktreesStrict(repoPath)
      reportDiscovery(worktrees)
      await pruneReleased
      pruneLineageForMissingRepoWorktrees(store as never, repo, worktrees, scanLineageRevision)
    })()

    const discoveredWorktrees = await discovery
    expect(discoveredWorktrees.map((worktree) => worktree.path)).not.toContain(childPath)
    git(repoPath, ['worktree', 'add', '--quiet', '-b', 'feature/race', childPath])
    // A wall-clock rollback must not make this causally newer write look old.
    vi.setSystemTime(scanStartedAt - 60_000)
    store.setWorktreeLineage(childId, {
      worktreeId: childId,
      worktreeInstanceId: 'child-instance',
      parentWorktreeId: parentId,
      parentWorktreeInstanceId: 'parent-instance',
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'explicit' },
      createdAt: Date.now()
    })
    store.setWorkspaceLineage({
      childWorkspaceKey,
      childInstanceId: 'child-instance',
      parentWorkspaceKey: worktreeWorkspaceKey(parentId),
      parentInstanceId: 'parent-instance',
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'explicit' },
      createdAt: Date.now()
    })
    releasePrune()
    await scan

    expect((await listWorktreesStrict(repoPath)).map((worktree) => worktree.path)).toContain(
      childPath
    )
    expect(removeWorktreeLineage).not.toHaveBeenCalled()
    expect(removeWorkspaceLineage).not.toHaveBeenCalled()
    expect(worktreeLineageById[childId]).toBeDefined()
    expect(workspaceLineageByChildKey[childWorkspaceKey]).toBeDefined()
  })
})
