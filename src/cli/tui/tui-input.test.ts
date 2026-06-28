import { describe, expect, it, vi } from 'vitest'
import { handleKey, type ControllerHost, type ControllerOverlay } from './tui-input'
import { handleMouse } from './tui-mouse'
import { buildWorktreeSnapshot, flattenWorktreeRows } from './worktree-snapshot'
import { worktreeIndicatorKind } from './agent-state-indicator'
import { makePsResult, makeWorktreeSummary } from './worktree-snapshot-fixtures'
import type { SessionTab } from './session-tab'
import type { MouseEvent } from './mouse-input'
import type { LogicalKey } from './tty-key-adapter'

function sessionTab(id: string, title: string, worktreeId = 'wt-1'): SessionTab {
  return {
    worktreeId,
    id,
    kind: 'terminal',
    title,
    terminalHandle: id,
    relativePath: null,
    url: null
  }
}

const snapshot = buildWorktreeSnapshot(
  makePsResult([
    makeWorktreeSummary({ worktreeId: 'wt-1', isActive: true, liveTerminalCount: 1 }),
    makeWorktreeSummary({
      worktreeId: 'wt-2',
      displayName: 'feature/y',
      isActive: true,
      liveTerminalCount: 1
    })
  ])
)
const rows = flattenWorktreeRows(snapshot)

function makeHost(overrides: Partial<ControllerHost> = {}): ControllerHost {
  let overlay: ControllerOverlay = { kind: 'none' }
  return {
    worktreeRows: () => rows,
    selected: () => rows[0] ?? null,
    selectedIndex: () => 0,
    isNarrow: () => false,
    narrowView: () => 'list',
    sidebarWidth: () => 30,
    columns: () => 100,
    bodyHeight: () => 20,
    snapshot: () => snapshot,
    resolveKind: (row) => worktreeIndicatorKind(row.status, row.agents),
    terminals: () => [sessionTab('t1', 'shell')],
    tabsByWorktree: () => new Map(),
    tabsExpanded: () => false,
    focusedTabId: () => 't1',
    overlay: () => overlay,
    inputValue: () => '',
    terminalFocused: () => false,
    selectIndex: vi.fn(),
    move: vi.fn(),
    setNarrowView: vi.fn(),
    cycleFocus: vi.fn(),
    focusTerminal: vi.fn(),
    exitTerminalFocus: vi.fn(),
    scrollTerminal: vi.fn(),
    toggleTabs: vi.fn(),
    jumpToTab: vi.fn(),
    toggleFiles: vi.fn(),
    fileBrowserOpen: () => false,
    clickFile: vi.fn(),
    editorClick: vi.fn(),
    setOverlay: vi.fn((next: ControllerOverlay) => {
      overlay = next
    }),
    setInput: vi.fn(),
    runCommand: vi.fn(),
    refresh: vi.fn(),
    quit: vi.fn(),
    ...overrides
  }
}

const key = (k: LogicalKey): LogicalKey => k

describe('handleKey', () => {
  it('routes arrow/jk navigation to move', () => {
    const host = makeHost()
    handleKey(host, key({ type: 'down' }))
    expect(host.move).toHaveBeenCalledWith(1)
  })

  it('quits on q', () => {
    const host = makeHost()
    handleKey(host, key({ type: 'char', value: 'q' }))
    expect(host.quit).toHaveBeenCalled()
  })

  it('opens help and closes it on the next key', () => {
    const host = makeHost()
    handleKey(host, key({ type: 'char', value: '?' }))
    expect(host.setOverlay).toHaveBeenCalledWith({ kind: 'help' })
    handleKey(host, key({ type: 'char', value: 'x' }))
    expect(host.setOverlay).toHaveBeenLastCalledWith({ kind: 'none' })
  })

  it('cycles terminal focus on tab', () => {
    const host = makeHost()
    handleKey(host, key({ type: 'tab' }))
    expect(host.cycleFocus).toHaveBeenCalled()
  })

  it('focuses the terminal for input on Enter (wide)', () => {
    const host = makeHost()
    handleKey(host, key({ type: 'enter' }))
    expect(host.focusTerminal).toHaveBeenCalled()
  })

  it('toggles nested tabs on t', () => {
    const host = makeHost()
    handleKey(host, key({ type: 'char', value: 't' }))
    expect(host.toggleTabs).toHaveBeenCalled()
  })

  it('opens a prompt for new-worktree and submits a built command', () => {
    const host = makeHost({ inputValue: () => 'feature-y' })
    handleKey(host, key({ type: 'char', value: 'n' }))
    const call = (host.setOverlay as ReturnType<typeof vi.fn>).mock.calls.find(
      ([o]) => o.kind === 'prompt'
    )
    expect(call).toBeTruthy()
    const overlay = call?.[0] as Extract<ControllerOverlay, { kind: 'prompt' }>
    handleKey(host, key({ type: 'enter' }))
    expect(overlay.build('feature-y')).toMatchObject({ kind: 'worktree.create', name: 'feature-y' })
  })

  it('runs the command on a confirm-y', () => {
    const command = { kind: 'worktree.rm', worktree: 'id:wt-1', force: true } as const
    const host = makeHost({ overlay: () => ({ kind: 'confirm', message: 'Remove?', command }) })
    handleKey(host, key({ type: 'char', value: 'y' }))
    expect(host.runCommand).toHaveBeenCalledWith(command)
  })
})

const press = (col: number, row: number): MouseEvent => ({
  type: 'press',
  button: 'left',
  col,
  row
})

describe('handleMouse', () => {
  it('scrolls the selection when the terminal is not focused', () => {
    const host = makeHost()
    handleMouse(host, { type: 'scroll', direction: 'down', col: 0, row: 0 })
    expect(host.move).toHaveBeenCalledWith(1)
    expect(host.scrollTerminal).not.toHaveBeenCalled()
  })

  it('scrolls terminal history (up = older) when the terminal is focused', () => {
    const host = makeHost({ terminalFocused: () => true })
    handleMouse(host, { type: 'scroll', direction: 'up', col: 0, row: 0 })
    expect(host.scrollTerminal).toHaveBeenCalledWith(3)
    expect(host.move).not.toHaveBeenCalled()
  })

  it('focuses the terminal when the viewport body is clicked (wide)', () => {
    const host = makeHost()
    handleMouse(host, press(60, 10))
    expect(host.focusTerminal).toHaveBeenCalled()
  })

  it('switches to and focuses a different workspace clicked in the sidebar', () => {
    const host = makeHost()
    // lines: header(0) spacer(1) group(2) row(3=idx0) row(4=idx1); selected is 0,
    // so screenRow 5 (idx1) is a different workspace.
    handleMouse(host, press(2, 5))
    expect(host.selectIndex).toHaveBeenCalledWith(1)
    expect(host.focusTerminal).toHaveBeenCalled()
  })

  it('focuses the workspace area when the already-selected workspace is clicked', () => {
    const host = makeHost({ terminalFocused: () => true })
    handleMouse(host, press(2, 4)) // screenRow 4 = idx0 = the selected workspace
    expect(host.exitTerminalFocus).toHaveBeenCalled()
    expect(host.selectIndex).not.toHaveBeenCalled()
  })

  const expandedTabsHost = (over: Partial<ControllerHost> = {}) =>
    makeHost({
      tabsExpanded: () => true,
      focusedTabId: () => null,
      tabsByWorktree: () =>
        new Map([
          ['wt-1', [sessionTab('t1', 'shell')]],
          ['wt-2', [sessionTab('t2', 'shell', 'wt-2')]]
        ]),
      ...over
    })

  it('jumps to a nested tab when its sidebar line is clicked', () => {
    const host = expandedTabsHost()
    // lines: header(0) spacer(1) group(2) row-wt1(3) tab-t1(4) row-wt2(5) tab-t2(6)
    // screenRow 5 → lineIndex 4 → the wt-1 tab.
    handleMouse(host, press(2, 5))
    expect(host.jumpToTab).toHaveBeenCalledWith(0, 't1')
  })

  it('does not close from the sidebar — a nested-tab right-click just jumps', () => {
    const host = expandedTabsHost()
    handleMouse(host, { type: 'press', button: 'right', col: 2, row: 5 })
    expect(host.jumpToTab).toHaveBeenCalledWith(0, 't1')
    expect(host.setOverlay).not.toHaveBeenCalled()
  })

  it('does not close a worktree from a sidebar right-click', () => {
    const host = expandedTabsHost()
    // screenRow 4 → lineIndex 3 → row-wt1 (worktree index 0).
    handleMouse(host, { type: 'press', button: 'right', col: 2, row: 4 })
    expect(host.setOverlay).not.toHaveBeenCalled()
  })

  it('jumps to a tab when the tab strip is clicked', () => {
    const host = makeHost({ focusedTabId: () => null })
    // Tab strip starts at sidebarWidth + 2 = 32; first tab "❯ shell" spans it.
    handleMouse(host, press(34, 1))
    expect(host.jumpToTab).toHaveBeenCalledWith(0, 't1')
  })

  it('confirms closing the tab when the already-focused tab is clicked', () => {
    const host = expandedTabsHost({ focusedTabId: () => 't1' })
    handleMouse(host, press(34, 1))
    expect(host.setOverlay).toHaveBeenCalledWith(expect.objectContaining({ kind: 'confirm' }))
    expect(host.jumpToTab).not.toHaveBeenCalled()
  })

  it('opens the terminal view when a narrow list row is clicked', () => {
    const host = makeHost({ isNarrow: () => true, narrowView: () => 'list' })
    handleMouse(host, press(0, 4))
    expect(host.selectIndex).toHaveBeenCalledWith(0)
    expect(host.setNarrowView).toHaveBeenCalledWith('terminal')
  })
})
