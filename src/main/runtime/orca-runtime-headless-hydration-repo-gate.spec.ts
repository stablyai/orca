import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

export function registerOrcaRuntimeHeadlessHydrationRepoGateTests(): void {
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

  // #9343: skip sessions for removed repos without treating unavailable inventory as universal removal.
  describe('headless mobile session hydration repo gate', () => {
    it('hydrates when the store cannot report repos at all', async () => {
      const runtime = new OrcaRuntimeService({
        getWorkspaceSession: () => makeSession(WORKTREE_ID)
      } as never)

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
        getRepo: () => null,
        getRepos
      } as never)

      // Floating terminals lack repo-derived identity; never enumerate repos on this hot poll path.
      await runtime.listMobileSessionTabs(`id:${FLOATING_TERMINAL_WORKTREE_ID}`)
      expect(getRepos).not.toHaveBeenCalled()
    })
  })
}
