import { vi, type Mock } from 'vitest'
import type { CreateWorktreeArgs } from '../shared/worktree/create-types'
import type { Worktree } from '../shared/worktree/types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import { getDefaultSettings } from '../shared/constants'
import { firstWorkRenameDeps } from './agent-hooks/first-work-rename-runtime'
import {
  maybeAutoRenameBranchOnFirstWork,
  resetFirstWorkBranchRenameState
} from './agent-hooks/first-work-branch-rename'
import { gitResponder, workingEvent } from './agent-hooks/first-work-branch-rename-test-harness'
import { mergeWorktree } from './ipc/worktree-metadata-merge'

export const typedLabelCreateRequests: Pick<
  CreateWorktreeArgs,
  'name' | 'displayName' | 'displayNameKind'
>[] = [
  { name: '認証を修正', displayName: '認証を修正', displayNameKind: 'user' },
  { name: 'fix-authentication', displayNameKind: 'user' }
]

export const generatedNameCreateRequest: Pick<CreateWorktreeArgs, 'name' | 'nameWasGenerated'> = {
  name: 'nautilus',
  nameWasGenerated: true
}

export async function renameCreatedWorktreeOnFirstWork(
  worktree: Worktree,
  initialMeta: Partial<WorktreeMeta>,
  gitMock: Mock
): Promise<Worktree> {
  resetFirstWorkBranchRenameState()
  let meta: WorktreeMeta = {
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
    ...initialMeta
  }
  let branch = worktree.branch.replace(/^refs\/heads\//, '')
  const respond = gitResponder({ currentBranch: branch, hasUpstream: false })
  gitMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'branch' && args[1] === '-m') {
      branch = args[2]
    }
    return respond(args)
  })
  const repo = {
    id: worktree.repoId,
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '',
    addedAt: 0
  }
  const deps = firstWorkRenameDeps(
    {
      getSettings: () => ({
        ...getDefaultSettings('/tmp/pr-32919-fixture'),
        autoRenameBranchFromWork: true,
        branchPrefix: 'none'
      }),
      getRepo: () => repo,
      getRepos: () => [repo],
      getWorktreeMeta: () => meta,
      setWorktreeMeta: (_target, updates) => (meta = { ...meta, ...updates }),
      getFolderWorkspace: () => undefined,
      updateFolderWorkspace: () => null,
      getWorktreeIdForTab: () => worktree.id
    },
    {
      getCommitMessageAgentEnvironmentResolvers: () => undefined,
      notifyFolderWorkspaceChanged: vi.fn(),
      notifyBranchRenamed: vi.fn(),
      notifyWorktreeFolderRenamed: vi.fn()
    }
  )
  await maybeAutoRenameBranchOnFirstWork(workingEvent({ worktreeId: worktree.id }), deps)
  return mergeWorktree(worktree.repoId, { ...worktree, branch: `refs/heads/${branch}` }, meta)
}
