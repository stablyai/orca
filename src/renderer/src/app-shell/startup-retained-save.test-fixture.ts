import { vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { RetainedTerminalDestination } from '../../../shared/workspace-layout/retained-terminal-destination'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import type { createStore } from '../../../main/persistence/persistence-test-harness'
import {
  makeTerminalTab,
  TEST_LEAF_1,
  TEST_LEAF_2,
  TEST_LEAF_LIVE
} from '../../../main/persistence/persistence-session-fixtures'
import type { createTestStore } from '../store/testing/app-store-test-fixture'
import { buildPaneConnectionDeps } from '../components/terminal-pane/pty-connection/test-fixtures/pty-connection-test-deps'
import { mockPanePtyArgs } from '../components/terminal-pane/pty-connection/test-fixtures/pty-connection-test-connect-mock-pane'
import {
  createPane,
  createManager
} from '../components/terminal-pane/pty-connection/test-fixtures/pty-connection-test-pane-fixtures'
import type { ConnectPanePtySession } from '../components/terminal-pane/pty-connection/connect-pane-pty-session'
import type { PtyTransport } from '../components/terminal-pane/pty-transport/pty-transport-types'
import { TerminalIdleCursorReset } from '../components/terminal-pane/emulation/terminal-idle-cursor-reset'
import { TerminalStreamPosition } from '../components/terminal-pane/pty-transport/delivery/terminal-stream-position'

import { WORKTREE, writeUnseenStartupHistory } from './startup-retained-save-history.test-fixture'

export { WORKTREE, expectUnseenDestinations } from './startup-retained-save-history.test-fixture'
export const LATER_LEAF = '44444444-4444-4444-8444-444444444444'

export function savedStartupSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: 'repo1',
    activeWorktreeId: WORKTREE,
    activeTabId: 'renderer-tab',
    activeTabIdByWorktree: { [WORKTREE]: 'renderer-tab' },
    tabsByWorktree: {
      [WORKTREE]: [
        makeTerminalTab({ id: 'renderer-tab', ptyId: null }),
        makeTerminalTab({ id: 'later-tab', ptyId: null })
      ]
    },
    terminalLayoutsByTabId: {
      'renderer-tab': {
        root: { type: 'leaf', leafId: TEST_LEAF_1 },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null
      },
      'later-tab': {
        root: { type: 'leaf', leafId: LATER_LEAF },
        activeLeafId: LATER_LEAF,
        expandedLeafId: null
      }
    },
    unifiedTabs: {
      [WORKTREE]: ['renderer-tab', 'browser-tab', 'later-tab'].map((id, sortOrder) => ({
        id,
        entityId: id,
        groupId: 'A',
        contentType: id === 'browser-tab' ? 'browser' : 'terminal',
        worktreeId: WORKTREE,
        label: id,
        customLabel: null,
        color: null,
        sortOrder,
        createdAt: 1
      }))
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
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    },
    tabGroups: {
      [WORKTREE]: [
        {
          id: 'A',
          worktreeId: WORKTREE,
          tabOrder: ['renderer-tab', 'browser-tab', 'later-tab'],
          activeTabId: 'renderer-tab'
        }
      ]
    },
    tabGroupLayouts: { [WORKTREE]: { type: 'leaf', groupId: 'A' } },
    activeGroupIdByWorktree: { [WORKTREE]: 'A' }
  }
}

export function laterStartupDestination(
  session: WorkspaceSessionState
): RetainedTerminalDestination {
  return {
    start: {
      worktreeId: WORKTREE,
      runtimeId: 'runtime-local',
      executionHostId: 'local',
      tabId: 'later-tab',
      leafId: LATER_LEAF,
      bindingGeneration: 0,
      startSequence: 1,
      status: 'failed',
      reason: 'The shell could not be started.'
    },
    tab: session.tabsByWorktree[WORKTREE][1],
    layout: session.terminalLayoutsByTabId['later-tab'],
    group: session.tabGroups?.[WORKTREE]?.[0],
    groupLayout: session.tabGroupLayouts?.[WORKTREE]
  }
}

/** Admissions happen after the window read; no retained descriptor tells the window about these. */
export async function admitUnseenStartupDestinations(
  store: ReturnType<typeof createStore>,
  historyPath: string
): Promise<void> {
  const tab = await store.admitTerminalPane({
    type: 'createTerminalTab',
    workspace: WORKTREE,
    tabId: 'host-tab',
    leafId: TEST_LEAF_2,
    groupId: 'B',
    split: { besideGroupId: 'A', direction: 'right' }
  })
  const split = await store.admitTerminalPane({
    type: 'splitPane',
    workspace: WORKTREE,
    tabId: 'renderer-tab',
    leafId: TEST_LEAF_1,
    newLeafId: TEST_LEAF_LIVE,
    direction: 'vertical',
    ratio: 0.65
  })
  if (tab !== 'admitted' || split !== 'admitted') {
    throw new Error('host admission failed')
  }
  for (const [tabId, leafId, ptyId, incarnationId] of [
    ['host-tab', TEST_LEAF_2, 'host-pty', 'host-incarnation'],
    ['renderer-tab', TEST_LEAF_LIVE, 'split-pty', 'split-incarnation']
  ]) {
    if (
      !(await store.persistPtyBinding({
        worktreeId: WORKTREE,
        tabId,
        leafId,
        ptyId,
        incarnationId,
        mayCreate: false
      }))
    ) {
      throw new Error('host binding failed')
    }
    writeUnseenStartupHistory(historyPath, ptyId)
  }
}

/** Existing pane fixtures supply the UI/transport boundary; the automatic-start wait stays real. */
export function restoredStartupPane(store: ReturnType<typeof createTestStore>) {
  const [pane, manager, deps] = mockPanePtyArgs(
    createPane(1),
    createManager(),
    buildPaneConnectionDeps(store.getState, {
      tabId: 'renderer-tab',
      worktreeId: WORKTREE
    })
  )
  const startFreshSpawn = vi.fn(async () => 'unexpected-new-pty')
  const session: ConnectPanePtySession = {
    pane,
    manager,
    deps,
    transport: {
      attach: vi.fn<PtyTransport['attach']>(),
      connect: vi.fn<PtyTransport['connect']>(),
      disconnect: vi.fn<PtyTransport['disconnect']>(),
      sendInput: vi.fn<PtyTransport['sendInput']>(() => true),
      sendInputImmediate: vi.fn<PtyTransport['sendInputImmediate']>(() => true),
      resize: vi.fn<PtyTransport['resize']>(() => true),
      isConnected: () => false,
      getPtyId: () => null
    },
    writeReplayData: () => undefined,
    hiddenOutputRestoreUnhideSeq: null,
    idleCursorReset: new TerminalIdleCursorReset(),
    streamPosition: new TerminalStreamPosition(),
    skippedQueryCarry: null,
    admitStreamBytes: (data) => data,
    admitRecoveryBytes: (data) => data,
    cacheKey: `renderer-tab:${TEST_LEAF_1}`,
    runtimeEnvironmentId: null,
    userRestart: false,
    disposed: false,
    waitTeardowns: [],
    startFreshSpawn
  }
  return { session, startFreshSpawn }
}
