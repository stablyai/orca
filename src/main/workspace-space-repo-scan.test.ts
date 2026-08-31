import { describe, expect, it } from 'vitest'
import type { WorkspaceSpaceWorktree } from '../shared/workspace-space-types'
import { summarizeWorkspaceSpaceRows } from './workspace-space-repo-scan'

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
