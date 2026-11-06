import { describe, expect, it, vi } from 'vitest'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { firstWorkRenameDeps } from './first-work-rename-runtime'

const BASE_META: WorktreeMeta = {
  displayName: 'workspace',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  orcaCreationSource: 'desktop'
}

function depsFor(meta: WorktreeMeta) {
  return firstWorkRenameDeps(
    {
      getSettings: vi.fn(),
      getRepo: vi.fn(),
      getRepos: vi.fn(),
      getWorktreeMeta: () => meta,
      setWorktreeMeta: vi.fn(),
      getFolderWorkspace: vi.fn(),
      updateFolderWorkspace: vi.fn()
    },
    {
      getCommitMessageAgentEnvironmentResolvers: vi.fn(),
      notifyFolderWorkspaceChanged: vi.fn(),
      notifyBranchRenamed: vi.fn(),
      notifyWorktreeFolderRenamed: vi.fn()
    }
  )
}

describe('first-work branch rename eligibility', () => {
  it('never renames a branch the user switched to or created in Orca', () => {
    expect(depsFor(BASE_META).canRenameOrcaCreatedBranch('repo::/w')).toBe(true)
    expect(
      depsFor({ ...BASE_META, branchNameIsUserChosen: true }).canRenameOrcaCreatedBranch('repo::/w')
    ).toBe(false)
  })
})
