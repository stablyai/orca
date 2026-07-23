import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeHeadIdentity } from '../../shared/types'
import {
  createWorktreeHeadIdentityRefreshState,
  refreshWorktreeHeadIdentities
} from './worktree-head-identity-refresh'
import { readGitCommonHeadIdentities } from './worktree-head-identity-reader'
import { notifyWorktreeHeadIdentitiesChanged } from './worktree-remote'

vi.mock('./worktree-head-identity-reader', () => ({
  readGitCommonHeadIdentities: vi.fn()
}))
vi.mock('./worktree-remote', () => ({
  notifyWorktreeHeadIdentitiesChanged: vi.fn()
}))

const readMock = vi.mocked(readGitCommonHeadIdentities)
const notifyMock = vi.mocked(notifyWorktreeHeadIdentitiesChanged)

function makeHost(): Parameters<typeof refreshWorktreeHeadIdentities>[0] {
  return {
    path: '/repos/project/.git',
    repos: new Map([['repo-1', {}]]),
    mainWindow: { isDestroyed: () => false } as BrowserWindow,
    disposed: false
  }
}

async function refreshTwice(
  first: WorktreeHeadIdentity[],
  second: WorktreeHeadIdentity[]
): Promise<void> {
  const host = makeHost()
  const state = createWorktreeHeadIdentityRefreshState()
  readMock.mockResolvedValueOnce(first)
  await refreshWorktreeHeadIdentities(host, state, true)
  readMock.mockResolvedValueOnce(second)
  await refreshWorktreeHeadIdentities(host, state, true)
}

describe('refreshWorktreeHeadIdentities rebase-state sensitivity', () => {
  beforeEach(() => {
    readMock.mockReset()
    notifyMock.mockReset()
  })

  it('notifies when only the rebase state drops (git rebase --quit keeps HEAD detached)', async () => {
    const quit: WorktreeHeadIdentity = { worktreePath: '/wt', head: 'abc123', branch: null }
    await refreshTwice([{ ...quit, rebasing: true, rebaseBranch: 'feature/x' }], [quit])
    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(notifyMock).toHaveBeenCalledWith(expect.anything(), 'repo-1', [quit])
  })

  it('notifies when a rebase starts without moving HEAD', async () => {
    const detached: WorktreeHeadIdentity = { worktreePath: '/wt', head: 'abc123', branch: null }
    const rebasing: WorktreeHeadIdentity = {
      ...detached,
      rebasing: true,
      rebaseBranch: 'feature/x'
    }
    await refreshTwice([detached], [rebasing])
    expect(notifyMock).toHaveBeenCalledWith(expect.anything(), 'repo-1', [rebasing])
  })

  it('stays silent for identical identities', async () => {
    const identity: WorktreeHeadIdentity = {
      worktreePath: '/wt',
      head: 'abc123',
      branch: null,
      rebasing: true,
      rebaseBranch: 'feature/x'
    }
    await refreshTwice([identity], [{ ...identity }])
    expect(notifyMock).not.toHaveBeenCalled()
  })
})
