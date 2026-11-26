import { beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { dismissFirstWorkRename } from './first-work-rename-dismiss'
import { firstWorkDismissDeps, firstWorkRenameDeps } from './first-work-rename-runtime'
import { getFirstWorkRetryAvailability } from './first-work-rename-retry'
import {
  isFirstWorkRenameSettled,
  resetFirstWorkBranchRenameState
} from './first-work-rename-attempts'

const REPO: Repo = { id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 1 }
const WORKTREE_ID = 'repo-1::/repo/barracuda-208'

// The persisted metadata a restart reads back; everything else is rebuilt from it.
function makeStore(meta: Record<string, WorktreeMeta>) {
  return {
    getSettings: () => ({ autoRenameBranchFromWork: true }) as never,
    getRepo: (id: string) => (id === REPO.id ? REPO : undefined),
    getRepos: () => [REPO],
    getWorktreeMeta: (id: string) => meta[id],
    setWorktreeMeta: (target: { id: string }, updates: Partial<WorktreeMeta>) => {
      meta[target.id] = { ...meta[target.id], ...updates } as WorktreeMeta
      return meta[target.id]
    },
    getFolderWorkspace: () => undefined,
    updateFolderWorkspace: () => undefined
  } as unknown as Parameters<typeof firstWorkRenameDeps>[0]
}

const runtime = {
  getCommitMessageAgentEnvironmentResolvers: () => undefined,
  notifyFolderWorkspaceChanged: () => {},
  notifyBranchRenamed: () => {},
  notifyWorktreeFolderRenamed: () => {}
} as unknown as Parameters<typeof firstWorkRenameDeps>[1]

describe('dismissFirstWorkRename', () => {
  beforeEach(() => resetFirstWorkBranchRenameState())

  it('keeps the name across a restart: the error stays cleared and nothing retries', async () => {
    const meta: Record<string, WorktreeMeta> = {
      [WORKTREE_ID]: {
        orcaCreationSource: 'desktop',
        orcaCreatedAt: 1,
        firstAgentMessageRenameError: 'Generation timed out after 60s.'
      } as WorktreeMeta
    }
    const store = makeStore(meta)

    expect(dismissFirstWorkRename(WORKTREE_ID, firstWorkDismissDeps(store, runtime))).toEqual({
      dismissed: true
    })
    expect(meta[WORKTREE_ID].firstAgentMessageRenameError).toBeNull()
    const incarnation = firstWorkRenameDeps(store, runtime).readIncarnation(WORKTREE_ID)!
    expect(isFirstWorkRenameSettled(WORKTREE_ID, incarnation)).toBe(true)

    // Restart: in-memory settling is gone, only the persisted mark remains.
    resetFirstWorkBranchRenameState()
    const deps = firstWorkRenameDeps(store, runtime)
    expect(deps.canRenameOrcaCreatedBranch(WORKTREE_ID)).toBe(false)
    expect(await getFirstWorkRetryAvailability(WORKTREE_ID, 'local', deps)).toEqual({
      available: false,
      runningAttemptId: null
    })
    // A late failure from an attempt already in flight must not bring the error back.
    deps.setRenameError(WORKTREE_ID, 'Generation timed out after 60s.')
    expect(meta[WORKTREE_ID].firstAgentMessageRenameError).toBeNull()
  })

  it('reports a workspace that no longer exists as not dismissed', () => {
    const store = makeStore({})
    expect(dismissFirstWorkRename(WORKTREE_ID, firstWorkDismissDeps(store, runtime))).toEqual({
      dismissed: false
    })
  })
})
