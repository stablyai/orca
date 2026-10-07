import { describe, expect, it } from 'vitest'
import type { GitWorktreeInfo } from '../../../src/shared/worktree/types'
import type { WorkspaceLineage } from '../../../src/shared/worktree/lineage-types'
import type { WorkspaceKey } from '../../../src/shared/folder-workspace-types'
import { getLineageStatus } from '../../../src/main/lineage/lineage-git-status-service'
import { resolveLineageMembers } from '../../../src/main/lineage/lineage-member-resolver'
import { createLineagePatternScanCache } from '../../../src/main/lineage/lineage-pattern-scan-cache'
import type { LineageStoreContract } from '../../../src/main/lineage/workspace-lineage-service'

const PARENT: WorkspaceKey = 'folder:tower'

function child(key: WorkspaceKey): WorkspaceLineage {
  return {
    childWorkspaceKey: key,
    parentWorkspaceKey: PARENT,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 0
  }
}

describe('SSH lineage children', () => {
  const store: LineageStoreContract = {
    getAllWorkspaceLineage: () => ({
      a: child('worktree:remote::/remote/home/api'),
      b: child('worktree:local::/definitely/not/here')
    }),
    getRepos: () => [
      { id: 'remote', path: '/remote/home/api-repo', displayName: 'api', connectionId: 'ssh-1' },
      { id: 'local', path: '/repos/local', displayName: 'local' }
    ],
    getSettings: () => ({ lineageDiscovery: { patternEnabled: false } })
  }

  it('keeps a remote child as unverifiable and still drops a missing local path', async () => {
    const { members } = await resolveLineageMembers(store, PARENT)
    expect(members).toEqual([
      expect.objectContaining({
        repoName: 'api',
        worktreePath: '/remote/home/api',
        worktreeId: 'remote::/remote/home/api',
        matchedBy: 'lineage',
        unverifiable: true
      })
    ])
  })

  it('never runs local git status for an unverifiable worktree', async () => {
    const seen: string[] = []
    const payload = await getLineageStatus(store, PARENT, {
      gitStatusFn: async (p) => {
        seen.push(p)
        throw new Error('must not run')
      }
    })
    expect(seen).toEqual([])
    expect(payload.projects.api.worktrees).toEqual([
      expect.objectContaining({ dirtyFiles: [], unverifiable: true })
    ])
  })

  it('keeps a remote tower worktree as the unverifiable tower member', async () => {
    const remoteTower = 'worktree:remote::/remote/home/tower'
    const towerStore: LineageStoreContract = { ...store, getAllWorkspaceLineage: () => ({}) }
    const { members } = await resolveLineageMembers(towerStore, remoteTower)
    expect(members).toEqual([
      expect.objectContaining({
        isTower: true,
        unverifiable: true,
        worktreePath: '/remote/home/tower'
      })
    ])
  })
})

describe('pattern scan cache', () => {
  const repos = [{ id: 'r1', path: '/repos/r1', displayName: 'r1' }]
  const store: LineageStoreContract = {
    getRepos: () => repos,
    getFolderWorkspace: () => ({ name: 'ABC-1 fleet' })
  }

  function countingList(): {
    calls: string[]
    fn: (p: string) => Promise<GitWorktreeInfo[]>
  } {
    const calls: string[] = []
    return {
      calls,
      fn: async (p) => {
        calls.push(p)
        return [
          {
            path: `${p}-x`,
            head: 'h',
            branch: 'refs/heads/ABC-1',
            isBare: false,
            isMainWorktree: false
          }
        ]
      }
    }
  }

  it('serves a second resolution from the cache and bypasses it with force', async () => {
    const list = countingList()
    const patternScanCache = createLineagePatternScanCache()
    const opts = { listWorktreesFn: list.fn, patternScanCache }
    const first = await resolveLineageMembers(store, PARENT, opts)
    const second = await resolveLineageMembers(store, PARENT, opts)
    expect(list.calls).toEqual(['/repos/r1'])
    expect(second.members).toEqual(first.members)
    await resolveLineageMembers(store, PARENT, { ...opts, force: true })
    expect(list.calls).toEqual(['/repos/r1', '/repos/r1'])
  })

  it('expires entries after the TTL and on clear', async () => {
    let now = 0
    const list = countingList()
    const patternScanCache = createLineagePatternScanCache({ ttlMs: 5000, now: () => now })
    const opts = { listWorktreesFn: list.fn, patternScanCache }
    await resolveLineageMembers(store, PARENT, opts)
    now = 4999
    await resolveLineageMembers(store, PARENT, opts)
    expect(list.calls).toHaveLength(1)
    now = 5000
    await resolveLineageMembers(store, PARENT, opts)
    expect(list.calls).toHaveLength(2)
    patternScanCache.clear()
    await resolveLineageMembers(store, PARENT, opts)
    expect(list.calls).toHaveLength(3)
  })

  it('stays bounded', async () => {
    const patternScanCache = createLineagePatternScanCache({ maxEntries: 2 })
    const calls: string[] = []
    const load = (p: string) => async () => {
      calls.push(p)
      return []
    }
    await patternScanCache.getOrLoad('a', load('a'))
    await patternScanCache.getOrLoad('b', load('b'))
    await patternScanCache.getOrLoad('c', load('c'))
    await patternScanCache.getOrLoad('a', load('a'))
    expect(calls).toEqual(['a', 'b', 'c', 'a'])
  })
})
