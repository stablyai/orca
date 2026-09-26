import { describe, expect, it } from 'vitest'
import type { RecoveryProvenance } from '../../../shared/cross-machine-recovery-descriptor'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { mergeRuntimeFolderWorkspace } from '../../runtime/runtime-folder-workspace'
import { getFolderWorkspaceRootId, mergeFolderWorkspace } from './folder-workspace-model'

const repo: Repo = {
  id: 'repo-1',
  path: '/Users/dev/projects/site',
  displayName: 'site',
  badgeColor: '#000000',
  addedAt: 0,
  kind: 'folder'
}

const recoveryProvenance: RecoveryProvenance = {
  importKey: 'import-1',
  checkpointId: 'checkpoint-1',
  importedAt: 10,
  source: {
    runtimeId: 'runtime-a',
    machineName: 'laptop',
    platform: 'darwin',
    appVersion: '1.0.0',
    worktreeId: 'src-repo::/src/site',
    instanceId: 'inst-src',
    path: '/src/site',
    exportedAt: 5
  },
  presentationSource: { kind: 'host-layout' }
}

const meta: WorktreeMeta = {
  displayName: '',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  recoveryProvenance
}

describe('folder workspace recovery provenance', () => {
  it.each([
    ['ipc', mergeFolderWorkspace],
    ['runtime', mergeRuntimeFolderWorkspace]
  ] as const)('projects persisted recovery provenance through the %s merge', (_, merge) => {
    const merged = merge(repo, getFolderWorkspaceRootId(repo), meta)

    expect(merged.recoveryProvenance).toEqual(recoveryProvenance)
  })

  it('omits the key when no provenance was persisted', () => {
    const { recoveryProvenance: _omitted, ...plainMeta } = meta

    expect('recoveryProvenance' in mergeFolderWorkspace(repo, 'id', plainMeta)).toBe(false)
  })
})
