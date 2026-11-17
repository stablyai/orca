import { describe, expect, it } from 'vitest'
import './bind-first-pane.test-fixture'
import '../terminal/layout/profile-session-store.test-fixture'
import '../__fixtures__/main-layout-close-fixture'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import '../orca-runtime-test-mocks/setup.spec'
import '../../../shared/orca-profiles/constants'

import { TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'
import '../../../shared/worktree/host-qualified-identity'

describe('OrcaRuntimeService', () => {
  it('keeps published mobile terminal handles usable across renderer graph epochs', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'Terminal 1'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Terminal 1',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const tab = result.tabs[0]
    expect(tab?.type).toBe('terminal')
    if (tab?.type !== 'terminal' || tab.status !== 'ready') {
      throw new Error('expected ready terminal tab')
    }

    await runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'Terminal 1'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-2',
          snapshotVersion: 2,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Terminal 1',
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.onPtyData('pty-1', 'after graph sync\n', 100)

    await expect(runtime.readTerminal(tab.terminal)).resolves.toMatchObject({
      handle: tab.terminal,
      tail: ['after graph sync']
    })
  })

  it('preserves agentStatus and launchAgent when renaming a leaf-backed agent terminal tab and restores title on clear', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.markGraphReady(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-agent',
          worktreeId: TEST_WORKTREE_ID,
          title: '✳ Claude Code',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-agent',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-claude',
          paneTitle: '✳ Claude Code',
          title: '✳ Claude Code'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-agent::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-agent::pane:1',
              parentTabId: 'tab-agent',
              leafId: 'pane:1',
              ptyId: 'pty-claude',
              title: '✳ Claude Code',
              launchAgent: 'claude',
              agentStatus: {
                state: 'working',
                prompt: 'refactor',
                updatedAt: Date.now(),
                stateStartedAt: Date.now(),
                agentType: 'claude',
                paneKey: 'tab-agent:pane:1',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })

    const initial = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(initial.tabs).toHaveLength(1)
    const initialTab = initial.tabs[0]
    expect(initialTab).toMatchObject({
      title: '✳ Claude Code',
      launchAgent: 'claude',
      agentStatus: expect.objectContaining({ state: 'working', agentType: 'claude' })
    })
    expect(initialTab?.type).toBe('terminal')
    if (!initialTab || initialTab.type !== 'terminal' || !initialTab.terminal) {
      throw new Error('expected ready terminal tab')
    }
    const terminalHandle = initialTab.terminal

    // Controller title recorded on PTY without manual rename does not lock customTitle.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test fixture invokes protected runtime method to simulate controller state.
    const internals = runtime as unknown as {
      recordPtyWorktree: (ptyId: string, worktreeId: string, state: { title: string }) => void
    }
    internals.recordPtyWorktree('pty-claude', TEST_WORKTREE_ID, {
      title: 'Controller Seeded Title'
    })
    const beforeRename = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const beforeRenameTab = beforeRename.tabs[0]
    expect(beforeRenameTab?.type).toBe('terminal')
    if (beforeRenameTab?.type === 'terminal') {
      expect(beforeRenameTab.customTitle).toBeUndefined()
    }

    const renamed = await runtime.renameTerminal(terminalHandle, 'Auth Fix')
    expect(renamed).toMatchObject({
      handle: terminalHandle,
      tabId: 'tab-agent',
      title: 'Auth Fix'
    })

    const afterRename = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterRename.tabs[0]).toMatchObject({
      title: 'Auth Fix',
      customTitle: 'Auth Fix',
      launchAgent: 'claude',
      agentStatus: expect.objectContaining({ state: 'working', agentType: 'claude' })
    })
    const afterRenameTerminals = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(afterRenameTerminals.terminals[0]?.title).toBe('Auth Fix')

    runtime.onPtyData('pty-claude', '\x1b]0;✳ Claude Code (working)\x07', 100)
    const afterOsc = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterOsc.tabs[0]?.title).toBe('Auth Fix')
    const afterOscTerminals = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(afterOscTerminals.terminals[0]?.title).toBe('Auth Fix')

    await runtime.renameTerminal(terminalHandle, null)
    const afterClear = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterClear.tabs[0]?.title).toBe('✳ Claude Code (working)')
    const afterClearTerminals = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(afterClearTerminals.terminals[0]?.title).toBe('✳ Claude Code (working)')

    await runtime.renameTerminal(terminalHandle, 'Temporary Name')
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs[0]?.title).toBe(
      'Temporary Name'
    )
    await runtime.renameTerminal(terminalHandle, '   ')
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs[0]?.title).toBe(
      '✳ Claude Code (working)'
    )
  })
})
