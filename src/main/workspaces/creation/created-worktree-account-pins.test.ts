import { describe, expect, it, vi } from 'vitest'
import { pinCreatedWorktreeAccounts } from './created-worktree-account-pins'

describe('pinCreatedWorktreeAccounts', () => {
  const store = () => ({
    getSettings: () => ({
      claudeManagedAccounts: [{ id: 'claude-a', email: 'a@example.com' }],
      codexManagedAccounts: []
    }),
    updateSettings: vi.fn()
  })

  it('pins the new worktree and tells listeners, so routing sees it before the agent spawns', () => {
    const target = store()
    pinCreatedWorktreeAccounts(target, 'repo::wt', { claude: 'claude-a' })
    expect(target.updateSettings).toHaveBeenCalledWith(
      { claudeAccountPinsByWorktree: { 'repo::wt': 'claude-a' } },
      { notifyListeners: true }
    )
  })

  it('writes nothing without a valid choice', () => {
    const target = store()
    pinCreatedWorktreeAccounts(target, 'repo::wt', undefined)
    pinCreatedWorktreeAccounts(target, 'repo::wt', { claude: 'gone' })
    expect(target.updateSettings).not.toHaveBeenCalled()
  })
})
