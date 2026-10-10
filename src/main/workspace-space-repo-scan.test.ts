import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'
import type {
  WorkspaceSpaceScanProgress,
  WorkspaceSpaceWorktree
} from '../shared/workspace-space-types'
import type { Store } from './persistence'
import {
  scanWorkspaceSpaceRepo,
  summarizeWorkspaceSpaceRows,
  type WorkspaceSpaceScanLimiters
} from './workspace-space-repo-scan'

const passThroughLimiter: WorkspaceSpaceScanLimiters['localWorktree'] = (task) => task()

describe('summarizeWorkspaceSpaceRows', () => {
  it('reads each summary field once per row', () => {
    const reads = { status: 0, sizeBytes: 0, reclaimableBytes: 0 }
    const makeRow = (status: WorkspaceSpaceWorktree['status']) =>
      new Proxy({ status, sizeBytes: 10, reclaimableBytes: 4 } as WorkspaceSpaceWorktree, {
        get(target, property, receiver) {
          if (
            property === 'status' ||
            property === 'sizeBytes' ||
            property === 'reclaimableBytes'
          ) {
            reads[property] += 1
          }
          // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy get trap default forward.
          return Reflect.get(target, property, receiver)
        }
      })

    expect(summarizeWorkspaceSpaceRows([makeRow('ok'), makeRow('unavailable')])).toEqual({
      scannedWorktreeCount: 1,
      unavailableWorktreeCount: 1,
      totalSizeBytes: 20,
      reclaimableBytes: 8
    })
    expect(reads).toEqual({ status: 2, sizeBytes: 2, reclaimableBytes: 2 })
  })
})

describe('scanWorkspaceSpaceRepo', () => {
  it('does not scan a folder project as a Git worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-space-folder-'))
    try {
      const repo: Repo = {
        id: 'folder-1',
        path: root,
        displayName: 'Downloads',
        badgeColor: '#000',
        addedAt: 0,
        kind: 'folder'
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Folder scans return before any Store method is read.
      const store = {
        getRepos: () => [repo],
        getWorktreeMeta: () => undefined
      } as unknown as Store
      const readLocalDuDepthOne = vi.fn(async () => new Map<string, number>())
      const progress: WorkspaceSpaceScanProgress = {
        scanId: 'folder-scan',
        state: 'running',
        startedAt: 0,
        updatedAt: 0,
        totalRepoCount: 1,
        scannedRepoCount: 0,
        totalWorktreeCount: 0,
        scannedWorktreeCount: 0,
        currentRepoDisplayName: null,
        currentWorktreeDisplayName: null
      }
      const limiters: WorkspaceSpaceScanLimiters = {
        localWorktree: passThroughLimiter,
        remoteFallbackTraversal: passThroughLimiter
      }

      const result = await scanWorkspaceSpaceRepo({
        repo,
        scannedAt: 1,
        store,
        limiters,
        progress,
        options: {},
        readLocalDuDepthOne,
        normalizeLocalDuPath: (path) => path
      })

      expect(result.worktrees).toEqual([])
      expect(result.summary.worktreeCount).toBe(0)
      expect(result.summary.scannedWorktreeCount).toBe(0)
      expect(readLocalDuDepthOne).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
