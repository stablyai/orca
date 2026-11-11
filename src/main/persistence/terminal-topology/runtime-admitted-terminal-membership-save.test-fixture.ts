import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { Repo } from '../../../shared/repo-types'
import type { Tab } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import type { WorkspaceSessionSnapshot } from '../../../renderer/src/lib/workspace/persistence/workspace-session'
import { makeWorktree } from '../../../renderer/src/store/slices/worktrees/worktree.test-fixture'
import {
  makeTerminalTab,
  TEST_LEAF_1,
  TEST_LEAF_2,
  TEST_LEAF_EXPIRED
} from '../persistence-session-fixtures'

const WORKTREE = 'repo1::/worktree'

// Simulate a window snapshot that knows only its own tab.
export function rendererSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: WORKTREE,
    activeTabId: 'renderer-tab',
    tabsByWorktree: {
      [WORKTREE]: [
        makeTerminalTab({ id: 'renderer-tab', worktreeId: WORKTREE, ptyId: 'renderer-pty' })
      ]
    },
    terminalLayoutsByTabId: {
      'renderer-tab': {
        root: { type: 'leaf', leafId: TEST_LEAF_1 },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TEST_LEAF_1]: 'renderer-pty' }
      }
    }
  }
}

function entry(id: string, groupId: string, contentType: Tab['contentType']): Tab {
  return {
    id,
    entityId: id,
    groupId,
    contentType,
    worktreeId: WORKTREE,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

export function rendererWithGroups(): WorkspaceSessionState {
  return {
    ...rendererSession(),
    unifiedTabs: { [WORKTREE]: [entry('renderer-tab', 'A', 'terminal')] },
    tabGroups: {
      [WORKTREE]: [
        { id: 'A', worktreeId: WORKTREE, tabOrder: ['renderer-tab'], activeTabId: 'renderer-tab' }
      ]
    },
    tabGroupLayouts: { [WORKTREE]: { type: 'leaf', groupId: 'A' } },
    activeGroupIdByWorktree: { [WORKTREE]: 'A' }
  }
}

export function rendererWithLocalEdits(): WorkspaceSessionState {
  const session = rendererWithGroups()
  return {
    ...session,
    unifiedTabs: {
      [WORKTREE]: [
        ...session.unifiedTabs![WORKTREE]!,
        { ...entry('browser-tab', 'C', 'browser'), label: 'Research', isPinned: true },
        { ...entry('/worktree/notes.ts', 'D', 'editor'), label: 'Unsaved notes', isPreview: false }
      ]
    },
    tabGroups: {
      [WORKTREE]: [
        ...session.tabGroups![WORKTREE]!,
        { id: 'C', worktreeId: WORKTREE, tabOrder: ['browser-tab'], activeTabId: 'browser-tab' },
        {
          id: 'D',
          worktreeId: WORKTREE,
          tabOrder: ['/worktree/notes.ts'],
          activeTabId: '/worktree/notes.ts'
        },
        { id: 'E', worktreeId: WORKTREE, tabOrder: [], activeTabId: null }
      ]
    },
    tabGroupLayouts: {
      [WORKTREE]: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.4,
        first: { type: 'leaf', groupId: 'A' },
        second: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.3,
          first: { type: 'leaf', groupId: 'C' },
          second: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.7,
            first: { type: 'leaf', groupId: 'D' },
            second: { type: 'leaf', groupId: 'E' }
          }
        }
      }
    },
    openFilesByWorktree: {
      [WORKTREE]: [
        {
          filePath: '/worktree/notes.ts',
          relativePath: 'notes.ts',
          language: 'typescript',
          worktreeId: WORKTREE,
          dirtyDraftContent: 'export const marker = 42'
        }
      ]
    },
    browserTabsByWorktree: {
      [WORKTREE]: [
        {
          id: 'browser-tab',
          worktreeId: WORKTREE,
          url: 'https://example.test/research',
          title: 'Research',
          loading: false,
          faviconUrl: null,
          canGoBack: true,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    }
  }
}

export function rendererWithLocalEditsSnapshot(repo: Repo): WorkspaceSessionSnapshot {
  const session = rendererWithLocalEdits()
  return {
    activeRepoId: 'repo1',
    activeWorktreeId: WORKTREE,
    activeWorkspaceKey: 'worktree:repo1::/worktree',
    activeWorkspaceExecutionHostId: repo.executionHostId ?? 'local',
    activeTabId: 'renderer-tab',
    activeTabIdByWorktree: { [WORKTREE]: 'renderer-tab' },
    tabsByWorktree: session.tabsByWorktree,
    ptyIdsByTabId: { 'renderer-tab': ['renderer-pty'] },
    terminalLayoutsByTabId: session.terminalLayoutsByTabId,
    localOnlyScrollbackByTabId: {},
    openFiles: [
      {
        id: '/worktree/notes.ts',
        filePath: '/worktree/notes.ts',
        relativePath: 'notes.ts',
        worktreeId: WORKTREE,
        language: 'typescript',
        mode: 'edit',
        isDirty: true
      }
    ],
    editorDrafts: { '/worktree/notes.ts': 'export const marker = 42' },
    markdownFrontmatterVisible: {},
    activeFileIdByWorktree: { [WORKTREE]: '/worktree/notes.ts' },
    activeTabTypeByWorktree: { [WORKTREE]: 'editor' },
    browserTabsByWorktree: session.browserTabsByWorktree ?? {},
    browserPagesByWorkspace: {},
    browserAnnotationsByPageId: {},
    activeBrowserTabIdByWorktree: { [WORKTREE]: 'browser-tab' },
    browserUrlHistory: [],
    workspaceDocHistory: [],
    remoteBrowserPageHandlesByPageId: {},
    unifiedTabsByWorktree: session.unifiedTabs ?? {},
    groupsByWorktree: session.tabGroups ?? {},
    layoutByWorktree: session.tabGroupLayouts ?? {},
    activeGroupIdByWorktree: { [WORKTREE]: 'A' },
    sshConnectionStates: new Map(),
    repos: [repo],
    worktreesByRepo: {
      repo1: [
        makeWorktree({
          id: WORKTREE,
          repoId: 'repo1',
          path: '/worktree',
          hostId: repo.executionHostId ?? 'local'
        })
      ]
    },
    lastKnownRelayPtyIdByTabId: {},
    lastVisitedAtByWorktreeId: {},
    defaultTerminalTabsAppliedByWorktreeId: {}
  }
}

export function sharedAnchorSaveImages(): {
  initial: WorkspaceSessionState
  incoming: WorkspaceSessionState
} {
  const base = rendererWithGroups()
  const other = 'repo2::/untouched'
  const initial: WorkspaceSessionState = {
    ...base,
    tabsByWorktree: {
      [WORKTREE]: [
        ...base.tabsByWorktree[WORKTREE]!,
        makeTerminalTab({ id: 'anchor-tab', ptyId: 'anchor-pty' })
      ],
      [other]: [makeTerminalTab({ id: 'untouched-tab', ptyId: 'untouched-pty', worktreeId: other })]
    },
    terminalLayoutsByTabId: {
      ...base.terminalLayoutsByTabId,
      'anchor-tab': {
        root: { type: 'leaf', leafId: TEST_LEAF_2 },
        activeLeafId: TEST_LEAF_2,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TEST_LEAF_2]: 'anchor-pty' }
      },
      'untouched-tab': {
        root: { type: 'leaf', leafId: TEST_LEAF_EXPIRED },
        activeLeafId: TEST_LEAF_EXPIRED,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TEST_LEAF_EXPIRED]: 'untouched-pty' }
      }
    },
    unifiedTabs: {
      [WORKTREE]: [...base.unifiedTabs![WORKTREE]!, entry('anchor-tab', 'B', 'terminal')],
      [other]: [{ ...entry('untouched-tab', 'U', 'terminal'), worktreeId: other }]
    },
    tabGroups: {
      [WORKTREE]: [
        ...base.tabGroups![WORKTREE]!,
        { id: 'B', worktreeId: WORKTREE, tabOrder: ['anchor-tab'], activeTabId: 'anchor-tab' }
      ],
      [other]: [
        { id: 'U', worktreeId: other, tabOrder: ['untouched-tab'], activeTabId: 'untouched-tab' }
      ]
    },
    tabGroupLayouts: {
      [WORKTREE]: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.27,
        first: { type: 'leaf', groupId: 'A' },
        second: { type: 'leaf', groupId: 'B' }
      },
      [other]: { type: 'leaf', groupId: 'U' }
    }
  }
  const incoming: WorkspaceSessionState = {
    ...initial,
    browserTabsByWorktree: rendererWithLocalEdits().browserTabsByWorktree,
    unifiedTabs: {
      ...initial.unifiedTabs,
      [WORKTREE]: [...initial.unifiedTabs![WORKTREE]!, entry('browser-tab', 'X', 'browser')]
    },
    tabGroups: {
      ...initial.tabGroups,
      [WORKTREE]: [
        ...initial.tabGroups![WORKTREE]!,
        { id: 'X', worktreeId: WORKTREE, tabOrder: ['browser-tab'], activeTabId: 'browser-tab' },
        { id: 'E', worktreeId: WORKTREE, tabOrder: [], activeTabId: null }
      ]
    },
    tabGroupLayouts: {
      ...initial.tabGroupLayouts,
      [WORKTREE]: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.73,
        first: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.22,
          first: { type: 'leaf', groupId: 'A' },
          second: {
            type: 'split',
            direction: 'vertical',
            ratio: 0.37,
            first: { type: 'leaf', groupId: 'X' },
            second: { type: 'leaf', groupId: 'E' }
          }
        },
        second: { type: 'leaf', groupId: 'B' }
      }
    }
  }
  return { initial, incoming }
}
