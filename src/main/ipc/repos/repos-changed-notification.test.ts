import { describe, expect, it, vi } from 'vitest'

vi.mock('../folder-repo-git-upgrade-wake', () => ({ wakeFolderRepoGitUpgradeWatch: vi.fn() }))
vi.mock('../worktrees/creation/worktree-base-directory-watcher', () => ({
  scheduleCurrentWorktreeBaseDirectoryWatcherSync: vi.fn()
}))

import { notifyReposChanged, setRepoRemoteClientNotifier } from './repos-changed-notification'

describe('notifyReposChanged', () => {
  // Why: a removed or re-added project re-homes its automations; a cached Self row then failed delete with "host changed" (STA-12812).
  it('tells automation lists to re-read owners projected from the changed projects', () => {
    const notifier = {
      notifyReposChangedForRemoteClients: vi.fn(),
      notifyAutomationsChanged: vi.fn()
    }
    setRepoRemoteClientNotifier(notifier)

    notifyReposChanged(null)

    expect(notifier.notifyAutomationsChanged).toHaveBeenCalledWith({ reason: 'definition' })
  })

  it('still refreshes automation lists when the repo broadcast throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const notifier = {
      notifyReposChangedForRemoteClients: vi.fn(() => {
        throw new Error('client stream closed')
      }),
      notifyAutomationsChanged: vi.fn()
    }
    setRepoRemoteClientNotifier(notifier)

    notifyReposChanged(null)

    expect(notifier.notifyAutomationsChanged).toHaveBeenCalledOnce()
  })
})
