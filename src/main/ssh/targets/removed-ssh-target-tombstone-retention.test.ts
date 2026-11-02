import { describe, expect, it } from 'vitest'
import {
  capRemovedSshTargetTombstones,
  collectSshTargetRemovalEvidenceDependencies
} from './removed-ssh-target-tombstone-retention'
import type { RemovedSshTargetTombstone } from '../../../shared/ssh-types'
import type { FolderWorkspaceHostState } from '../../../shared/folder-workspace-execution-host'

function tombstones(count: number): RemovedSshTargetTombstone[] {
  return Array.from({ length: count }, (_, index) => ({
    oldTargetId: `ssh-${index}`,
    host: 'h',
    port: 22,
    username: 'u',
    label: `Host ${index}`,
    removedAt: index
  }))
}

describe('folder-workspace removal evidence', () => {
  it('retains a tombstone referenced by an automation workspace pin past the cap', () => {
    const all = tombstones(51)
    const workspaceState = {
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          folderPath: '/workspace',
          executionHostId: 'ssh:ssh-0'
        }
      ],
      projectGroups: [],
      repos: []
    } as unknown as FolderWorkspaceHostState
    const referenced = collectSshTargetRemovalEvidenceDependencies({
      automations: [
        { executionTargetType: 'local', executionTargetId: 'local', workspaceId: 'folder:folder-1' }
      ],
      workspaceState
    })

    const capped = capRemovedSshTargetTombstones(all, referenced)

    expect(capped).toHaveLength(50)
    expect(capped.some((entry) => entry.oldTargetId === 'ssh-0')).toBe(true)
    expect(capped.some((entry) => entry.oldTargetId === 'ssh-1')).toBe(false)
  })
})
