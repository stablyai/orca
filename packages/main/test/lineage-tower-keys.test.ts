import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GitWorktreeInfo } from '../../../src/shared/worktree/types'
import type { WorkspaceLineage } from '../../../src/shared/worktree/lineage-types'
import { extractKeysWithPattern } from '../../../src/main/lineage/lineage-key-extraction'
import {
  handleLineageMembersRequest,
  handleLineageStatusRequest
} from '../../../src/main/lineage/lineage-ipc-requests'
import { resolveTowerName } from '../../../src/main/lineage/lineage-tower-name'
import type { LineageStoreContract } from '../../../src/main/lineage/workspace-lineage-service'

function wt(worktreePath: string, branch: string): GitWorktreeInfo {
  return { path: worktreePath, head: 'abc', branch, isBare: false, isMainWorktree: false }
}

const gitStatusFn = async () => ({
  branch: 'b',
  head: 'h',
  conflictOperation: 'unknown' as const,
  entries: []
})

describe('tower key derivation in main', () => {
  it('finds pattern worktrees for a folder tower named "LEVGP-483 fleet"', async () => {
    const store: LineageStoreContract = {
      getRepos: () => [{ id: 'r1', path: '/repos/loan-core', displayName: 'loan-core' }],
      getFolderWorkspace: (id) => (id === 'f-1' ? { name: 'LEVGP-483 fleet' } : undefined)
    }
    const listWorktreesFn = async (): Promise<GitWorktreeInfo[]> => [
      wt('/repos/loan-core', 'refs/heads/main'),
      wt('/w/loan-core-x', 'refs/heads/feat/levgp-483-x')
    ]
    const res = await handleLineageMembersRequest(
      store,
      { parentWorkspaceKey: 'folder:f-1' },
      { listWorktreesFn }
    )
    expect(res.keys).toEqual(['LEVGP-483'])
    expect(res.members.map((m) => m.worktreePath)).toEqual(['/w/loan-core-x'])
  })

  it('never derives keys from the full worktree path', async () => {
    const id = 'r1::/home/u/node-18/release-2024/checkout'
    const store: LineageStoreContract = {
      getRepos: () => [{ id: 'r1', path: '/repos/r1', displayName: 'r1' }],
      getWorktree: () => ({ branch: 'main' })
    }
    expect(await resolveTowerName(store, `worktree:${id}`)).toBe('main checkout')
    const listWorktreesFn = async (): Promise<GitWorktreeInfo[]> => [
      wt('/w/node-18', 'refs/heads/node-18'),
      wt('/w/release', 'refs/heads/release-2024')
    ]
    const res = await handleLineageMembersRequest(
      store,
      { parentWorkspaceKey: `worktree:${id}` },
      { listWorktreesFn }
    )
    expect(res.keys).toEqual([])
    expect(res.members.filter((m) => m.matchedBy === 'pattern')).toEqual([])
  })

  it('reads the tower branch from the local repo worktree list when the store has none', async () => {
    const store: LineageStoreContract = {
      getRepos: () => [{ id: 'r1', path: '/repos/r1', displayName: 'r1' }]
    }
    const name = await resolveTowerName(store, 'worktree:r1::/w/tower-dir', {
      listWorktreesFn: async () => [wt('/w/tower-dir', 'refs/heads/feat/ABC-7-x')]
    })
    expect(name).toBe('feat/ABC-7-x tower-dir')
  })

  it('does not run git for a remote tower and uses its directory name only', async () => {
    const seen: string[] = []
    const store: LineageStoreContract = {
      getRepos: () => [{ id: 'r1', path: '/repos/r1', displayName: 'r1', connectionId: 'ssh-1' }]
    }
    const name = await resolveTowerName(store, 'worktree:r1::/remote/ABC-9-dir', {
      listWorktreesFn: async (p) => {
        seen.push(p)
        return []
      }
    })
    expect(name).toBe('ABC-9-dir')
    expect(seen).toEqual([])
  })

  it('applies the configured keyRegex', async () => {
    const store: LineageStoreContract = {
      getRepos: () => [],
      getSettings: () => ({ lineageDiscovery: { keyRegex: 'T\\d+' } }),
      getFolderWorkspace: () => ({ name: 'fleet T42 and LEVGP-1' })
    }
    const res = await handleLineageMembersRequest(store, { parentWorkspaceKey: 'folder:f' })
    expect(res.keys).toEqual(['T42'])
  })

  it('ignores renderer keys when the tower can be named, and uses them only when it cannot', async () => {
    const listWorktreesFn = async (): Promise<GitWorktreeInfo[]> => [
      wt('/w/x', 'refs/heads/feat/ZZZ-1')
    ]
    const repos = [{ id: 'r1', path: '/repos/r1', displayName: 'r1' }]
    const named: LineageStoreContract = {
      getRepos: () => repos,
      getFolderWorkspace: () => ({ name: 'plain tower' })
    }
    const ignored = await handleLineageStatusRequest(
      named,
      { parentWorkspaceKey: 'folder:f', ticketKeys: ['ZZZ-1'] },
      { listWorktreesFn, gitStatusFn }
    )
    expect(ignored.projects).toEqual({})
    const unnamed: LineageStoreContract = { getRepos: () => repos }
    const used = await handleLineageStatusRequest(
      unnamed,
      { parentWorkspaceKey: 'folder:f', ticketKeys: ['ZZZ-1'] },
      { listWorktreesFn, gitStatusFn }
    )
    expect(Object.keys(used.projects)).toEqual(['r1'])
  })

  it('returns the same member set from the status and members paths on one fixture', async () => {
    const childDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-child-'))
    const parent = 'folder:tower'
    const lineage: Record<string, WorkspaceLineage> = {
      c: {
        childWorkspaceKey: `worktree:r2::${childDir}`,
        parentWorkspaceKey: parent,
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 0
      }
    }
    const store: LineageStoreContract = {
      getAllWorkspaceLineage: () => lineage,
      getRepos: () => [
        { id: 'r1', path: '/repos/r1', displayName: 'loan-core' },
        { id: 'r2', path: '/repos/r2', displayName: 'credit' }
      ],
      getFolderWorkspace: () => ({ name: 'LEVGP-483 fleet' })
    }
    const listWorktreesFn = async (repoPath: string): Promise<GitWorktreeInfo[]> => [
      wt(`${repoPath}-a`, 'refs/heads/feat/levgp-483-a'),
      wt(`${repoPath}-b`, 'refs/heads/other')
    ]
    const deps = { listWorktreesFn, gitStatusFn }
    const status = await handleLineageStatusRequest(store, { parentWorkspaceKey: parent }, deps)
    const members = await handleLineageMembersRequest(store, { parentWorkspaceKey: parent }, deps)
    const fromStatus = Object.values(status.projects)
      .flatMap((p) => p.worktrees.map((w) => w.worktreePath))
      .sort()
    const fromMembers = members.members.map((m) => m.worktreePath).sort()
    expect(fromStatus).toEqual(fromMembers)
    expect(fromMembers).toEqual([path.resolve(childDir), '/repos/r1-a', '/repos/r2-a'].sort())
  })
})

describe('bounded user regex', () => {
  it('interrupts catastrophic backtracking and falls back to the default', () => {
    const started = Date.now()
    const res = extractKeysWithPattern('a'.repeat(40), '([A-Za-z0-9]+)+-\\d+')
    expect(Date.now() - started).toBeLessThan(1000)
    expect(res.error).toMatch(/invalid key pattern/i)
    expect(res.keys).toEqual([])
  })

  it('caps the input at 500 characters', () => {
    const res = extractKeysWithPattern(`${'x '.repeat(300)}ABC-1`, 'ABC-\\d+')
    expect(res.keys).toEqual([])
  })

  it('serves repeated extractions from the cache with independent arrays', () => {
    const first = extractKeysWithPattern('T1 T2', 'T\\d')
    first.keys.push('MUTATED')
    expect(extractKeysWithPattern('T1 T2', 'T\\d')).toEqual({ keys: ['T1', 'T2'] })
  })
})

describe('git:lineage-get-status input validation', () => {
  const store: LineageStoreContract = { getRepos: () => [] }

  it.each([undefined, null, {}, { parentWorkspaceKey: '' }, { parentWorkspaceKey: 5 }])(
    'returns a 400 payload for %j without throwing',
    async (args) => {
      const res = await handleLineageStatusRequest(store, args)
      expect(res).toMatchObject({ status: 400, totalDirtyFiles: 0, projects: {} })
      expect(res.error).toBeTruthy()
    }
  )

  it('rejects ticketKeys that are not an array of strings', async () => {
    for (const ticketKeys of ['ABC-1', [1], [null]]) {
      const res = await handleLineageStatusRequest(store, {
        parentWorkspaceKey: 'folder:f',
        ticketKeys
      })
      expect(res.status).toBe(400)
    }
  })
})
