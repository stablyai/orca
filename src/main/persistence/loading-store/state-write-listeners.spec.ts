import { expect, it } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'
import { WORKTREE_METADATA_DOMAINS } from './worktree-identity-metadata'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'

export function registerStateWriteListenersTests(): void {
  it('tells each write the domains it changed, undefined for a full save', async () => {
    const { store } = await fixture()
    const seen: (readonly string[] | undefined)[] = []
    const detach = store.onStateWritten((domains) => seen.push(domains))

    store.setWorktreeMeta(hostWorktreeTarget({ id: 'repo-1::/r/a', hostId: 'local' }), {
      isPinned: true
    })
    store.setWorktreeMeta(hostWorktreeTarget({ id: 'repo-1::/r/b', hostId: 'local' }), {
      isUnread: true
    })
    store.patchWorkspaceSession({ activeTabId: 'tab-1' })
    store.setWorktreeLineage(hostWorktreeTarget({ id: 'repo-1::/r/b', hostId: 'local' }), {
      worktreeId: 'repo-1::/r/b',
      worktreeInstanceId: 'b-1',
      parentWorktreeId: 'repo-1::/r/a',
      parentWorktreeInstanceId: 'a-1',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    })
    detach()
    store.setWorktreeMeta(hostWorktreeTarget({ id: 'repo-1::/r/a', hostId: 'local' }), {
      isPinned: false
    })

    expect(seen).toEqual([
      WORKTREE_METADATA_DOMAINS,
      WORKTREE_METADATA_DOMAINS,
      ['workspaceSession'],
      undefined
    ])
  })
}
