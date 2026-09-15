import { describe, expect, it, vi } from 'vitest'
import {
  recordCreatedWorktreeLineage,
  type WorktreeLineageRecordingResolution
} from './runtime-worktree-lineage-recording'
import { mergeWorktreeMetaForWrite } from '../persistence/loading-store/worktree-meta-write-normalization'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { WorktreeLineage, WorkspaceLineage } from '../../shared/worktree/lineage-types'

const parentId = 'parent-repo::/parent'
const resolution: WorktreeLineageRecordingResolution = {
  kind: 'lineage',
  parent: {
    type: 'worktree',
    worktree: { id: parentId },
    workspaceKey: `worktree:${parentId}`,
    instanceId: 'captured-parent'
  },
  origin: 'manual',
  capture: { source: 'manual-action', confidence: 'explicit' }
}

function recordingStore(meta: WorktreeMeta | undefined) {
  return {
    getRepos: () => [
      {
        id: 'parent-repo',
        path: '/repo',
        displayName: 'Parent',
        badgeColor: '',
        addedAt: 1,
        connectionId: 'builder'
      }
    ],
    getWorktreeMeta: () => meta,
    setWorktreeLineage: vi.fn((_id: string, lineage: WorktreeLineage) => lineage),
    setWorkspaceLineage: vi.fn((lineage: WorkspaceLineage) => lineage)
  }
}

describe('post-create lineage revalidation', () => {
  it.each([
    undefined,
    mergeWorktreeMetaForWrite(undefined, { instanceId: 'replacement', hostId: 'ssh:builder' }),
    mergeWorktreeMetaForWrite(undefined, { instanceId: 'captured-parent', hostId: 'local' })
  ])('drops a disappeared, replaced, or moved parent', (meta) => {
    const store = recordingStore(meta)
    const result = recordCreatedWorktreeLineage(
      store,
      { id: 'child-repo::/child', instanceId: 'child' },
      resolution,
      'ssh:builder'
    )
    expect(result).toMatchObject({
      lineage: null,
      workspaceLineage: null,
      warnings: [{ code: 'LINEAGE_PARENT_CONTEXT_MISSING' }]
    })
    expect(store.setWorktreeLineage).not.toHaveBeenCalled()
    expect(store.setWorkspaceLineage).not.toHaveBeenCalled()
  })

  it('retains owned legacy SSH metadata without a qualified reader', () => {
    const store = recordingStore(
      mergeWorktreeMetaForWrite(undefined, { instanceId: 'captured-parent' })
    )
    const result = recordCreatedWorktreeLineage(
      store,
      { id: 'child-repo::/child', instanceId: 'child' },
      resolution,
      'ssh:builder'
    )
    expect(result.lineage?.parentWorktreeId).toBe(parentId)
    expect(result.workspaceLineage?.parentInstanceId).toBe('captured-parent')
    expect(result.warnings).toEqual([])
  })
})
