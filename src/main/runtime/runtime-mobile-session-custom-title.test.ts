import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'

const TAB_ID = 'tab-ios-rename'
const LEAF_ID = 'pane:9'
const PTY_ID = 'pty-ios-rename'

function terminalTitle(runtime: OrcaRuntimeService): Promise<string> {
  return runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`).then((result) => {
    const tab = result.tabs.find((candidate) => candidate.type === 'terminal')
    if (tab?.type !== 'terminal') {
      throw new Error('expected a terminal session tab')
    }
    return tab.title
  })
}

describe('desktop terminal rename on the mobile session strip', () => {
  it('keeps a renamed title after later OSC titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    const renameTerminal = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal,
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: TEST_WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: 1,
          ptyId: PTY_ID,
          paneTitle: 'Terminal'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-ios-rename',
          snapshotVersion: 1,
          activeTabId: `${TAB_ID}::${LEAF_ID}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `${TAB_ID}::${LEAF_ID}`,
              parentTabId: TAB_ID,
              leafId: LEAF_ID,
              ptyId: PTY_ID,
              title: 'Terminal',
              isActive: true
            }
          ]
        }
      ]
    })

    runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', Date.now())
    expect(await terminalTitle(runtime)).toBe('Codex working')

    const [terminal] = (await runtime.listTerminals()).terminals
    await runtime.renameTerminal(terminal.handle, 'Ship notes')

    expect(renameTerminal).toHaveBeenCalledWith(TAB_ID, 'Ship notes')
    expect(await terminalTitle(runtime)).toBe('Ship notes')

    runtime.onPtyData(PTY_ID, '\x1b]0;Codex still working\x07', Date.now())
    expect(await terminalTitle(runtime)).toBe('Ship notes')

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Ship notes',
          activeLeafId: LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: TEST_WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: 1,
          ptyId: PTY_ID,
          paneTitle: 'Codex still working'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-ios-rename',
          snapshotVersion: 2,
          activeTabId: `${TAB_ID}::${LEAF_ID}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `${TAB_ID}::${LEAF_ID}`,
              parentTabId: TAB_ID,
              leafId: LEAF_ID,
              ptyId: PTY_ID,
              title: 'Ship notes',
              customTitle: 'Ship notes',
              isActive: true
            }
          ]
        }
      ]
    })
    const pty = (
      runtime as unknown as { ptysById: Map<string, { manualTitle?: string | null }> }
    ).ptysById.get(PTY_ID)
    expect(pty?.manualTitle).toBeUndefined()

    runtime.onPtyData(PTY_ID, '\x1b]0;Another task\x07', Date.now())
    expect(await terminalTitle(runtime)).toBe('Ship notes')

    await runtime.renameTerminal(terminal.handle, null)
    expect(await terminalTitle(runtime)).toBe('Another task')
    runtime.onPtyData(PTY_ID, '\x1b]0;Cleared task\x07', Date.now())
    expect(await terminalTitle(runtime)).toBe('Cleared task')
  })
})
