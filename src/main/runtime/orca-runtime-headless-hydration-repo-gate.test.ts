import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/types'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE_ID = 'repo::/worktree'
const REPO_ID = 'repo'

function makeSession(worktreeId: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: 'tab',
          ptyId: 'pty-1',
          worktreeId,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  }
}

// The repo gate (#9343) skips persisted session keys whose repo is gone. These
// pin the two ways that gate must not overreach.
describe('headless mobile session hydration repo gate', () => {
  it('hydrates when the store cannot report repos at all', async () => {
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => makeSession(WORKTREE_ID)
    } as never)

    // No getRepos on the store: an unavailable inventory must not read as
    // "every repo is gone" and silently drop every persisted tab.
    const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(result.tabs.length).toBeGreaterThan(0)
  })

  it('still skips a key whose repo is absent from a known inventory', async () => {
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => makeSession('ghost-repo::/worktree'),
      getRepos: () => [{ id: REPO_ID, path: '/repo', name: 'repo' }]
    } as never)

    const result = await runtime.listMobileSessionTabs('id:ghost-repo::/worktree')
    expect(result.tabs).toEqual([])
  })

  it('does not read the repo inventory for an unparseable worktree id', async () => {
    const getRepos = vi.fn(() => [{ id: REPO_ID, path: '/repo', name: 'repo' }])
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => makeSession(FLOATING_TERMINAL_WORKTREE_ID),
      // A separator-less id is validated against getRepo (singular) first.
      getRepo: () => null,
      getRepos
    } as never)

    // Floating terminals carry no `repoId::path` identity, and this hydrate runs
    // on a hot poll path — it must not enumerate repos.
    await runtime.listMobileSessionTabs(`id:${FLOATING_TERMINAL_WORKTREE_ID}`)
    expect(getRepos).not.toHaveBeenCalled()
  })
})
