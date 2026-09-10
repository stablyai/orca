import { describe, expect, it } from 'vitest'
import { createHeadlessMaestroAnnotationSnapshot } from './maestro-workspace-headless-annotation'

describe('headless Maestro annotation tabs', () => {
  it('publishes the exact annotation as an inactive markdown tab without changing selection', () => {
    const existing = {
      worktree: 'worktree-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 4,
      activeGroupId: 'group-1',
      activeTabId: 'terminal-1',
      activeTabType: 'terminal' as const,
      tabGroups: [{ id: 'group-1', activeTabId: 'terminal-1', tabOrder: ['terminal-1'] }],
      tabs: []
    }
    const result = createHeadlessMaestroAnnotationSnapshot({
      existing,
      worktreeId: 'worktree-1',
      filePath: '/repo/.orca/maestro/note.md',
      relativePath: '.orca/maestro/note.md',
      title: 'Mobile decision',
      fallbackGroupId: 'fallback'
    })

    expect(result.snapshot).toMatchObject({
      snapshotVersion: 5,
      activeTabId: 'terminal-1',
      activeTabType: 'terminal'
    })
    expect(result.snapshot.tabs).toContainEqual(
      expect.objectContaining({ id: result.tabId, type: 'markdown', isActive: false })
    )
    expect(result.snapshot.tabGroups?.[0]?.tabOrder).toEqual(['terminal-1', result.tabId])
  })
})
