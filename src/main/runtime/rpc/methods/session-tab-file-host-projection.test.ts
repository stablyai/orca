import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { projectSessionTabsForClient } from './session-tabs-inventory'

// #33424: this desktop opened README.md in a workspace of paired server A while A pairs back to it.
function desktopSnapshot(): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'repo::/work/app',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 3,
    activeGroupId: 'group-1',
    activeTabId: 'server-readme',
    activeTabType: 'markdown',
    tabGroups: [
      {
        id: 'group-1',
        activeTabId: 'server-readme',
        tabOrder: ['local-notes', 'server-readme'],
        recentTabIds: ['local-notes', 'server-readme']
      }
    ],
    tabs: [
      {
        type: 'file',
        id: 'local-notes',
        title: 'notes.txt',
        filePath: '/work/app/notes.txt',
        relativePath: 'notes.txt',
        language: 'plaintext',
        isDirty: false,
        isActive: false
      },
      {
        type: 'markdown',
        id: 'server-readme',
        title: 'README.md',
        filePath: '/work/app/README.md',
        relativePath: 'README.md',
        language: 'markdown',
        mode: 'edit',
        isDirty: false,
        isActive: true,
        sourceFileId: 'server-readme-file',
        sourceFilePath: '/work/app/README.md',
        sourceRelativePath: 'README.md',
        documentVersion: 'file:server-readme-file',
        hostRuntimeEnvironmentId: 'server-a'
      }
    ]
  }
}

describe("a desktop's tab on a paired server's file", () => {
  it('is not served to another runtime, which would take it as its own', () => {
    const served = projectSessionTabsForClient(desktopSnapshot(), 'runtime', [])
    expect(served.tabs.map((tab) => tab.id)).toEqual(['local-notes'])
    expect(served.tabGroups?.[0]?.tabOrder).toEqual(['local-notes'])
    expect(served.activeTabId).toBe('local-notes')
    expect(served.activeGroupId).toBe('group-1')
  })

  it('leaves another runtime no groups or focus when every row is on a server', () => {
    const snapshot = desktopSnapshot()
    const onlyServerRows = {
      ...snapshot,
      tabs: snapshot.tabs.filter((tab) => tab.id === 'server-readme'),
      tabGroups: snapshot.tabGroups?.map((group) => ({
        ...group,
        tabOrder: ['server-readme'],
        recentTabIds: ['server-readme']
      }))
    }
    const served = projectSessionTabsForClient(onlyServerRows, 'runtime', [])
    expect(served.tabs).toEqual([])
    expect(served.tabGroups).toBeUndefined()
    expect(served.activeTabId).toBeNull()
    expect(served.activeGroupId).toBeNull()
  })

  it.each([
    ['its phone', 'mobile' as const],
    ['a local caller', undefined]
  ])('is served to %s without the host stamp', (_label, clientKind) => {
    const served = projectSessionTabsForClient(desktopSnapshot(), clientKind, [])
    expect(served.tabs.map((tab) => tab.id)).toEqual(['local-notes', 'server-readme'])
    expect(served.tabs.some((tab) => 'hostRuntimeEnvironmentId' in tab)).toBe(false)
  })
})
