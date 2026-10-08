import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { buildOwnedEditorFileId } from '../../shared/editor-file-identity'
import { closeHostEditFile } from './host-editor-session-layout'
import { listHostEditTabs, openHostEditTab } from './host-editor-session-model'
import { editPersistedTabGroups } from './host-editor-tab-group-edit'

const WT = 'repo1::/path/wt1'
const OTHER_WT = 'repo2::/path/wt2'
const NOTE = '/path/wt1/notes.md'
const SAME_IDS = { toWrapperId: (id: string) => id, toSnapshotId: (id: string) => id }

function base(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...overrides
  }
}

function ids(): () => string {
  let next = 0
  return () => `uuid-${++next}`
}

const openArgs = {
  worktreeId: WT,
  filePath: NOTE,
  relativePath: 'notes.md',
  language: 'markdown',
  executionHostId: 'local' as const,
  activate: true,
  now: 5
}

describe('host editor session model', () => {
  it('writes the wrapper a window writes, in the active group, in a unified session', () => {
    const session = base({
      unifiedTabs: { [WT]: [] },
      tabGroups: { [WT]: [{ id: 'g-1', worktreeId: WT, activeTabId: null, tabOrder: ['term-1'] }] },
      activeGroupIdByWorktree: { [WT]: 'g-1' }
    })

    const { session: next, record } = openHostEditTab(session, { ...openArgs, newId: ids() })

    expect(next.unifiedTabs?.[WT]).toEqual([
      {
        id: 'uuid-1',
        entityId: NOTE,
        groupId: 'g-1',
        worktreeId: WT,
        executionHostId: 'local',
        contentType: 'editor',
        label: 'notes.md',
        customLabel: null,
        color: null,
        sortOrder: 1,
        createdAt: 5
      }
    ])
    expect(next.tabGroups?.[WT]?.[0]).toMatchObject({
      tabOrder: ['term-1', 'uuid-1'],
      activeTabId: 'uuid-1',
      recentTabIds: ['uuid-1']
    })
    expect(next.openFilesByWorktree?.[WT]).toEqual([
      { filePath: NOTE, relativePath: 'notes.md', worktreeId: WT, language: 'markdown' }
    ])
    expect(next.activeFileIdByWorktree?.[WT]).toBe(NOTE)
    expect(next.activeTabTypeByWorktree?.[WT]).toBe('editor')
    expect(record).toMatchObject({ tabId: 'uuid-1', fileId: NOTE, groupId: 'g-1' })
  })

  it('uses the owned file id when another workspace already holds the same path', () => {
    const session = base({
      openFilesByWorktree: {
        [OTHER_WT]: [
          { filePath: NOTE, relativePath: 'notes.md', worktreeId: OTHER_WT, language: 'markdown' }
        ]
      }
    })

    const { record } = openHostEditTab(session, { ...openArgs, newId: ids() })

    expect(record.fileId).toBe(buildOwnedEditorFileId(NOTE, WT, undefined))
    expect(record.tabId).toBe(NOTE)
  })

  it('re-derives ids when the stored rows change in place, as a worktree rename does', () => {
    const row = (worktreeId: string) => ({
      filePath: NOTE,
      relativePath: 'notes.md',
      worktreeId,
      language: 'markdown'
    })
    const openFilesByWorktree: Record<string, ReturnType<typeof row>[]> = {
      [OTHER_WT]: [row(OTHER_WT)]
    }
    const session = base({ openFilesByWorktree })
    expect(listHostEditTabs(session, OTHER_WT).map((record) => record.fileId)).toEqual([NOTE])

    openFilesByWorktree[WT] = [row(WT)]
    delete openFilesByWorktree[OTHER_WT]
    expect(listHostEditTabs(session, WT).map((record) => record.fileId)).toEqual([NOTE])
    expect(listHostEditTabs(session, OTHER_WT)).toEqual([])

    openFilesByWorktree[WT]!.unshift(row(WT))
    openFilesByWorktree[OTHER_WT] = []
    expect(listHostEditTabs(session, WT)).toHaveLength(1)
    openFilesByWorktree[OTHER_WT].push(row(OTHER_WT))
    expect(listHostEditTabs(session, OTHER_WT).map((record) => record.fileId)).toEqual([
      buildOwnedEditorFileId(NOTE, OTHER_WT, undefined)
    ])
  })

  it('dedupes by owner and path, preferring the active group wrapper', () => {
    const session = base({
      openFilesByWorktree: {
        [WT]: [{ filePath: NOTE, relativePath: 'notes.md', worktreeId: WT, language: 'markdown' }]
      },
      unifiedTabs: {
        [WT]: [
          {
            id: 'a',
            entityId: NOTE,
            groupId: 'g-1',
            worktreeId: WT,
            contentType: 'editor',
            label: '',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'b',
            entityId: NOTE,
            groupId: 'g-2',
            worktreeId: WT,
            contentType: 'editor',
            label: '',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [WT]: [
          { id: 'g-1', worktreeId: WT, activeTabId: 'a', tabOrder: ['a'] },
          { id: 'g-2', worktreeId: WT, activeTabId: 'b', tabOrder: ['b'] }
        ]
      },
      activeGroupIdByWorktree: { [WT]: 'g-2' }
    })

    const result = openHostEditTab(session, { ...openArgs, newId: ids() })

    expect(result.created).toBe(false)
    expect(result.record.tabId).toBe('b')
    expect(result.session.openFilesByWorktree?.[WT]).toHaveLength(1)
  })

  it('closes the file entity, removing every split wrapper and collapsing an emptied group', () => {
    const session = base({
      openFilesByWorktree: {
        [WT]: [{ filePath: NOTE, relativePath: 'notes.md', worktreeId: WT, language: 'markdown' }]
      },
      unifiedTabs: {
        [WT]: [
          {
            id: 'term-1',
            entityId: 'term-1',
            groupId: 'g-1',
            worktreeId: WT,
            contentType: 'terminal',
            label: '',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'a',
            entityId: NOTE,
            groupId: 'g-1',
            worktreeId: WT,
            contentType: 'editor',
            label: '',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          },
          {
            id: 'b',
            entityId: NOTE,
            groupId: 'g-2',
            worktreeId: WT,
            contentType: 'editor',
            label: '',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [WT]: [
          {
            id: 'g-1',
            worktreeId: WT,
            activeTabId: 'a',
            tabOrder: ['term-1', 'a'],
            recentTabIds: ['term-1', 'a']
          },
          { id: 'g-2', worktreeId: WT, activeTabId: 'b', tabOrder: ['b'] }
        ]
      },
      tabGroupLayouts: {
        [WT]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'g-1' },
          second: { type: 'leaf', groupId: 'g-2' }
        }
      },
      activeGroupIdByWorktree: { [WT]: 'g-2' },
      activeFileIdByWorktree: { [WT]: NOTE },
      activeTabTypeByWorktree: { [WT]: 'editor' }
    })
    const [record] = listHostEditTabs(session, WT)

    const next = closeHostEditFile(session, WT, record!)

    expect(next.openFilesByWorktree?.[WT]).toEqual([])
    expect(next.unifiedTabs?.[WT]?.map((tab) => tab.id)).toEqual(['term-1'])
    expect(next.tabGroups?.[WT]).toEqual([
      expect.objectContaining({ id: 'g-1', tabOrder: ['term-1'], activeTabId: 'term-1' })
    ])
    expect(next.tabGroupLayouts?.[WT]).toEqual({ type: 'leaf', groupId: 'g-1' })
    expect(next.activeGroupIdByWorktree?.[WT]).toBe('g-1')
    expect(next.activeTabTypeByWorktree?.[WT]).toBe('terminal')
  })

  it('persists a move as group order plus each wrapper group and order', () => {
    const session = base({
      unifiedTabs: {
        [WT]: [
          {
            id: 'term-1',
            entityId: 'term-1',
            groupId: 'g-1',
            worktreeId: WT,
            contentType: 'terminal',
            label: '',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'a',
            entityId: NOTE,
            groupId: 'g-1',
            worktreeId: WT,
            contentType: 'editor',
            label: '',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [WT]: [{ id: 'g-1', worktreeId: WT, activeTabId: 'a', tabOrder: ['term-1', 'a'] }]
      }
    })

    const next = editPersistedTabGroups(
      session,
      WT,
      {
        tabGroups: [
          { id: 'g-1', activeTabId: 'term-1', tabOrder: ['term-1'] },
          { id: 'g-2', activeTabId: 'a', tabOrder: ['a'] }
        ],
        tabGroupLayout: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'g-1' },
          second: { type: 'leaf', groupId: 'g-2' }
        },
        activeGroupId: 'g-2'
      },
      SAME_IDS
    )!

    expect(next.unifiedTabs?.[WT]?.find((tab) => tab.id === 'a')).toMatchObject({
      groupId: 'g-2',
      sortOrder: 0
    })
    expect(next.tabGroups?.[WT]?.map((group) => [group.id, group.tabOrder])).toEqual([
      ['g-1', ['term-1']],
      ['g-2', ['a']]
    ])
    expect(next.activeGroupIdByWorktree?.[WT]).toBe('g-2')
  })

  it('renumbers siblings like a window when an earlier close left a sortOrder gap', () => {
    const wrapper = (id: string, sortOrder: number, isPinned = false) => ({
      id,
      entityId: id,
      groupId: 'g-1',
      worktreeId: WT,
      contentType: 'terminal' as const,
      label: '',
      customLabel: null,
      color: null,
      sortOrder,
      createdAt: 1,
      ...(isPinned ? { isPinned } : {})
    })
    const session = base({
      // A pinned tab first, then a gap: sortOrder 2 already exists at tabOrder index 1.
      unifiedTabs: { [WT]: [wrapper('pinned', 0, true), wrapper('term-2', 2)] },
      tabGroups: {
        [WT]: [{ id: 'g-1', worktreeId: WT, activeTabId: 'term-2', tabOrder: ['pinned', 'term-2'] }]
      },
      activeGroupIdByWorktree: { [WT]: 'g-1' }
    })

    const { session: next } = openHostEditTab(session, { ...openArgs, newId: ids() })

    expect(next.tabGroups?.[WT]?.[0]?.tabOrder).toEqual(['pinned', 'term-2', 'uuid-1'])
    expect(next.unifiedTabs?.[WT]?.map((tab) => [tab.id, tab.sortOrder])).toEqual([
      ['pinned', 0],
      ['term-2', 1],
      ['uuid-1', 2]
    ])
  })

  it('never invents the legacy terminal group in a unified session', () => {
    const session = base({
      unifiedTabs: { [WT]: [] },
      tabGroups: { [WT]: [{ id: 'g-1', worktreeId: WT, activeTabId: null, tabOrder: [] }] }
    })

    const next = editPersistedTabGroups(
      session,
      WT,
      {
        tabGroups: [
          { id: `headless-terminals:${WT}`, activeTabId: 'term-1', tabOrder: ['term-1'] }
        ],
        activeGroupId: `headless-terminals:${WT}`
      },
      SAME_IDS
    )

    expect(next).toBeNull()
  })

  it('leaves transient tabs out of a persisted layout and refocuses the group', () => {
    const session = base({
      unifiedTabs: { [WT]: [] },
      tabGroups: {
        [WT]: [{ id: 'g-1', worktreeId: WT, activeTabId: 'term-1', tabOrder: ['term-1'] }]
      }
    })

    const next = editPersistedTabGroups(
      session,
      WT,
      {
        tabGroups: [
          {
            id: 'g-1',
            activeTabId: 'diff-1',
            tabOrder: ['diff-1', 'term-1'],
            recentTabIds: ['term-1', 'diff-1']
          }
        ],
        activeGroupId: 'g-1'
      },
      { toWrapperId: (id) => (id === 'diff-1' ? null : id), toSnapshotId: (id) => id }
    )!

    expect(next.tabGroups?.[WT]).toEqual([
      expect.objectContaining({
        tabOrder: ['term-1'],
        activeTabId: 'term-1',
        recentTabIds: ['term-1']
      })
    ])
  })
})
