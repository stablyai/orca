import { describe, expect, it, vi } from 'vitest'
import type { RuntimeSyncWindowGraph } from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'

const TAB_ID = 'tab-ios-rename'
const LEAF_ID = 'pane:9'
const PTY_ID = 'pty-ios-rename'

function sessionGraph(snapshotVersion: number, customTitle?: string): RuntimeSyncWindowGraph {
  return {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: TEST_WORKTREE_ID,
        title: customTitle ?? 'Terminal',
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
        activeGroupId: null,
        publicationEpoch: 'epoch-ios-rename',
        snapshotVersion,
        activeTabId: `${TAB_ID}::${LEAF_ID}`,
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: `${TAB_ID}::${LEAF_ID}`,
            parentTabId: TAB_ID,
            leafId: LEAF_ID,
            ptyId: PTY_ID,
            title: customTitle ?? 'Terminal',
            ...(customTitle ? { customTitle } : {}),
            isActive: true
          }
        ]
      }
    ]
  }
}

function terminalTitle(runtime: OrcaRuntimeService): Promise<string> {
  return runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`).then((result) => {
    const tab = result.tabs.find((candidate) => candidate.type === 'terminal')
    if (tab?.type !== 'terminal') {
      throw new Error('expected a terminal session tab')
    }
    return tab.title
  })
}

function pendingManualTitle(runtime: OrcaRuntimeService): {
  manualTitle?: string | null
  manualTitleBaseline?: string
} {
  const pty = (
    runtime as unknown as {
      ptysById: Map<string, { manualTitle?: string | null; manualTitleBaseline?: string }>
    }
  ).ptysById.get(PTY_ID)
  if (!pty) {
    throw new Error('expected a pty record')
  }
  return pty
}

function openRuntime(): { runtime: OrcaRuntimeService; renameTerminal: ReturnType<typeof vi.fn> } {
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
  return { runtime, renameTerminal }
}

describe('desktop terminal rename on the mobile session strip', () => {
  it('keeps a renamed title after later OSC titles', async () => {
    const { runtime, renameTerminal } = openRuntime()
    runtime.syncWindowGraph(1, sessionGraph(1))

    runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', Date.now())
    expect(await terminalTitle(runtime)).toBe('Codex working')

    const [terminal] = (await runtime.listTerminals()).terminals
    await runtime.renameTerminal(terminal.handle, 'Ship notes')

    expect(renameTerminal).toHaveBeenCalledWith(TAB_ID, 'Ship notes')
    expect(await terminalTitle(runtime)).toBe('Ship notes')

    runtime.onPtyData(PTY_ID, '\x1b]0;Codex still working\x07', Date.now())
    expect(await terminalTitle(runtime)).toBe('Ship notes')

    runtime.syncWindowGraph(1, sessionGraph(2, 'Ship notes'))
    expect(pendingManualTitle(runtime).manualTitle).toBeUndefined()

    runtime.onPtyData(PTY_ID, '\x1b]0;Another task\x07', Date.now())
    expect(await terminalTitle(runtime)).toBe('Ship notes')

    await runtime.renameTerminal(terminal.handle, null)
    expect(await terminalTitle(runtime)).toBe('Another task')
    runtime.onPtyData(PTY_ID, '\x1b]0;Cleared task\x07', Date.now())
    expect(await terminalTitle(runtime)).toBe('Cleared task')
  })

  it('keeps a phone rename ahead of the custom title it replaced', async () => {
    const { runtime } = openRuntime()
    runtime.syncWindowGraph(1, sessionGraph(1, 'Old mac name'))
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', Date.now())
    const [terminal] = (await runtime.listTerminals()).terminals
    await runtime.renameTerminal(terminal.handle, 'Phone name')

    expect(pendingManualTitle(runtime)).toMatchObject({
      manualTitle: 'Phone name',
      manualTitleBaseline: 'Old mac name'
    })
    runtime.syncWindowGraph(1, sessionGraph(2, 'Old mac name'))
    expect(await terminalTitle(runtime)).toBe('Phone name')
    expect(pendingManualTitle(runtime).manualTitle).toBe('Phone name')

    runtime.syncWindowGraph(1, sessionGraph(3, 'Desktop name'))
    expect(pendingManualTitle(runtime).manualTitle).toBeUndefined()
    expect(await terminalTitle(runtime)).toBe('Desktop name')
  })

  it('keeps a split rename until the desktop publishes a custom title', async () => {
    const { runtime } = openRuntime()
    runtime.syncWindowGraph(1, sessionGraph(1))
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', Date.now())
    const [terminal] = (await runtime.listTerminals()).terminals
    await runtime.renameTerminal(terminal.handle, 'Phone name')

    expect(pendingManualTitle(runtime).manualTitleBaseline).toBe('')
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex still working\x07', Date.now())
    runtime.syncWindowGraph(1, sessionGraph(2))
    expect(await terminalTitle(runtime)).toBe('Phone name')

    runtime.syncWindowGraph(1, sessionGraph(3, 'Desktop name'))
    expect(pendingManualTitle(runtime).manualTitle).toBeUndefined()
    expect(await terminalTitle(runtime)).toBe('Desktop name')
  })
})
