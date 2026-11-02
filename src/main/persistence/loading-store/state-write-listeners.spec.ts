import { expect, it } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'
import { WORKTREE_METADATA_DOMAINS } from './worktree-identity-metadata'

export function registerStateWriteListenersTests(): void {
  it('tells each write the domains it changed, undefined for a full save', async () => {
    const { store } = await fixture()
    const seen: (readonly string[] | undefined)[] = []
    const detach = store.onStateWritten((domains) => seen.push(domains))

    store.setWorktreeMeta('repo-1::/r/a', { isPinned: true })
    store.setWorktreeMetaForHost('repo-1::/r/b', 'local', { isUnread: true })
    store.patchWorkspaceSession({ activeTabId: 'tab-1' })
    store.setWorktreeLineage('repo-1::/r/b', {
      worktreeId: 'repo-1::/r/b',
      worktreeInstanceId: 'b-1',
      parentWorktreeId: 'repo-1::/r/a',
      parentWorktreeInstanceId: 'a-1',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    })
    detach()
    store.setWorktreeMeta('repo-1::/r/a', { isPinned: false })

    expect(seen).toEqual([
      ['worktreeMeta'],
      WORKTREE_METADATA_DOMAINS,
      ['workspaceSession'],
      undefined
    ])
  })
}
