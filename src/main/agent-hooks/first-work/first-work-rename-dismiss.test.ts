import { beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { getDefaultSettings } from '../../../shared/orca-profiles/constants'
import { dismissFirstWorkRename } from './first-work-rename-dismiss'
import { firstWorkDismissDeps, firstWorkRenameDeps } from './first-work-rename-runtime'
import { getFirstWorkRetryAvailability } from './first-work-rename-retry'
import {
  isFirstWorkRenameSettled,
  resetFirstWorkBranchRenameState
} from './first-work-rename-attempts'

const REPO: Repo = { id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 1 }
const WORKTREE_ID = 'repo-1::/repo/barracuda-208'
const FAILED_META: WorktreeMeta = {
  displayName: 'barracuda-208',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  orcaCreationSource: 'desktop',
  orcaCreatedAt: 1,
  firstAgentMessageRenameError: 'Generation timed out after 60s.'
}

type DismissStore = Parameters<typeof firstWorkRenameDeps>[0]
type Write = { id: string; hostId: string }

// The persisted metadata a restart reads back; everything else is rebuilt from it.
function makeStore(
  meta: Record<string, WorktreeMeta>,
  repos: Repo[] = [REPO],
  writes: Write[] = []
): DismissStore {
  return {
    getSettings: () => getDefaultSettings('/home/me'),
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    getWorktreeMeta: (id: string) => meta[id],
    setWorktreeMeta: (target, updates) => {
      writes.push({ id: target.id, hostId: target.hostId })
      const next: WorktreeMeta = { ...meta[target.id], ...updates }
      meta[target.id] = next
      return next
    },
    getFolderWorkspace: () => undefined,
    updateFolderWorkspace: () => null
  }
}

const runtime: Parameters<typeof firstWorkRenameDeps>[1] = {
  getCommitMessageAgentEnvironmentResolvers: () => undefined,
  notifyFolderWorkspaceChanged: () => {},
  notifyBranchRenamed: () => {},
  notifyWorktreeFolderRenamed: () => {}
}

describe('dismissFirstWorkRename', () => {
  beforeEach(() => resetFirstWorkBranchRenameState())

  it('keeps the name across a restart: the error stays cleared and nothing retries', async () => {
    const meta: Record<string, WorktreeMeta> = {
      [WORKTREE_ID]: { ...FAILED_META }
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

  it('writes this host’s own row when a same-id repo is also registered on another host', () => {
    const writes: Write[] = []
    const meta: Record<string, WorktreeMeta> = {
      [WORKTREE_ID]: { ...FAILED_META }
    }
    const store = makeStore(meta, [REPO, { ...REPO, executionHostId: 'runtime:g16' }], writes)

    expect(dismissFirstWorkRename(WORKTREE_ID, firstWorkDismissDeps(store, runtime))).toEqual({
      dismissed: true
    })
    expect(writes).toEqual([{ id: WORKTREE_ID, hostId: 'local' }])
    expect(meta[WORKTREE_ID]).toMatchObject({
      branchNameIsUserChosen: true,
      firstAgentMessageRenameError: null
    })
  })

  it('reports a workspace that no longer exists as not dismissed', () => {
    const store = makeStore({})
    expect(dismissFirstWorkRename(WORKTREE_ID, firstWorkDismissDeps(store, runtime))).toEqual({
      dismissed: false
    })
  })
})
