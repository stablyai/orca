import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import '../../orchestration/db/runtime-orchestration-db.test-fixture'
import { withDurableRuntimeStore } from '../../construction/test-context/runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import '../../../../shared/orca-profiles/constants'
import '../../orca-runtime-test-mocks/setup.spec'

import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  HEADLESS_THIRD_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import '../../construction/test-context/orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('restores orphan pane and group topology without replacing a newer host-owned tab', async () => {
    const newerLeafId = '44444444-4444-4444-8444-444444444444'
    const session: WorkspaceSessionState = {
      ...makeWorkspaceSessionWithHeadlessTerminal({
        activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'terminal-3' },
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'terminal-3',
              ptyId: 'pty-new',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Terminal 3',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 3
            }
          ]
        },
        terminalLayoutsByTabId: {
          'terminal-3': makeHeadlessTerminalLayout({ [newerLeafId]: 'pty-new' })
        }
      }),
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'group-live',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'terminal-3',
            tabOrder: ['terminal-3']
          }
        ]
      },
      tabGroupLayouts: {
        [TEST_WORKTREE_ID]: { type: 'leaf', groupId: 'group-live' }
      },
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-live' },
      terminalPtyIncarnationsByPaneKey: {
        [`terminal-3:${newerLeafId}`]: 'inc-new'
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(
      withDurableRuntimeStore({ ...runtimeStore, flushOrThrow: vi.fn() })
    )
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-new',
          incarnationId: 'inc-new',
          terminalHandle: 'term_new',
          title: 'Terminal 3',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        },
        {
          id: 'pty-agent',
          incarnationId: 'inc-agent',
          terminalHandle: 'term_agent',
          title: 'Claude',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        },
        {
          id: 'pty-setup',
          incarnationId: 'inc-setup',
          terminalHandle: 'term_setup',
          title: 'Setup',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        },
        {
          id: 'pty-shell',
          incarnationId: 'inc-shell',
          terminalHandle: 'term_shell',
          title: 'Shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    const adopted = await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: 0,
      activeTabId: 'tab-shell',
      activeGroupId: 'group-old-right',
      claims: [
        {
          terminal: 'term_agent',
          ptyId: 'pty-agent',
          incarnationId: 'inc-agent',
          tabId: 'tab-agent',
          leafId: HEADLESS_LEAF_ID
        },
        {
          terminal: 'term_setup',
          ptyId: 'pty-setup',
          incarnationId: 'inc-setup',
          tabId: 'tab-agent',
          leafId: HEADLESS_SECOND_LEAF_ID
        },
        {
          terminal: 'term_shell',
          ptyId: 'pty-shell',
          incarnationId: 'inc-shell',
          tabId: 'tab-shell',
          leafId: HEADLESS_THIRD_LEAF_ID
        }
      ],
      topology: {
        tabs: [
          {
            tabId: 'tab-agent',
            root: {
              type: 'split',
              direction: 'horizontal',
              ratio: 0.7,
              first: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
              second: { type: 'leaf', leafId: HEADLESS_SECOND_LEAF_ID }
            },
            activeLeafId: HEADLESS_SECOND_LEAF_ID,
            expandedLeafId: null
          },
          {
            tabId: 'tab-shell',
            root: { type: 'leaf', leafId: HEADLESS_THIRD_LEAF_ID },
            activeLeafId: HEADLESS_THIRD_LEAF_ID,
            expandedLeafId: HEADLESS_THIRD_LEAF_ID
          }
        ],
        groups: [
          {
            id: 'group-old-left',
            activeTabId: 'tab-agent',
            tabOrder: ['tab-agent'],
            recentTabIds: ['tab-agent']
          },
          {
            id: 'group-old-right',
            activeTabId: 'tab-shell',
            tabOrder: ['tab-shell']
          }
        ],
        groupLayout: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.6,
          first: { type: 'leaf', groupId: 'group-old-left' },
          second: { type: 'leaf', groupId: 'group-old-right' }
        }
      }
    })

    expect(adopted.snapshot.activeGroupId).toBe('group-old-right')
    expect(adopted.snapshot.activeTabId).toBe(`tab-shell::${HEADLESS_THIRD_LEAF_ID}`)
    expect(adopted.snapshot.tabGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'group-live', tabOrder: ['terminal-3'] }),
        expect.objectContaining({ id: 'group-old-left', tabOrder: ['tab-agent'] }),
        expect.objectContaining({ id: 'group-old-right', tabOrder: ['tab-shell'] })
      ])
    )
    expect(adopted.snapshot.tabGroupLayout).toMatchObject({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', groupId: 'group-live' },
      second: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.6,
        first: { type: 'leaf', groupId: 'group-old-left' },
        second: { type: 'leaf', groupId: 'group-old-right' }
      }
    })
    expect(getSession().terminalLayoutsByTabId['tab-agent']).toMatchObject({
      root: { type: 'split', direction: 'horizontal', ratio: 0.7 },
      activeLeafId: HEADLESS_SECOND_LEAF_ID,
      ptyIdsByLeafId: {
        [HEADLESS_LEAF_ID]: 'pty-agent',
        [HEADLESS_SECOND_LEAF_ID]: 'pty-setup'
      }
    })
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID].map((tab) => tab.id)).toEqual([
      'terminal-3',
      'tab-agent',
      'tab-shell'
    ])
    expect(
      getSession().unifiedTabs?.[TEST_WORKTREE_ID]?.map((tab) => [tab.id, tab.groupId])
    ).toEqual([
      ['terminal-3', 'group-live'],
      ['tab-agent', 'group-old-left'],
      ['tab-shell', 'group-old-right']
    ])
  })
})
