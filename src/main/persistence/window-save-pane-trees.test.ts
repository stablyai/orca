import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { windowSaveForMain } from './window-save-pane-trees'
import { applyPtyBinding } from './loading-store/pty-binding-session-update'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

const mains: TerminalLayoutSnapshot = {
  root: {
    type: 'split',
    direction: 'vertical',
    ratio: 0.3,
    first: { type: 'leaf', leafId: A },
    second: { type: 'leaf', leafId: B }
  },
  activeLeafId: A,
  expandedLeafId: null
}

function stored(layouts: Record<string, TerminalLayoutSnapshot>): WorkspaceSessionState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: windowSaveForMain reads only terminalLayoutsByTabId.
  return { terminalLayoutsByTabId: layouts } as WorkspaceSessionState
}

describe('windowSaveForMain', () => {
  it('keeps main’s pane tree, and the window’s focus, zoom and terminals', () => {
    const windows: TerminalLayoutSnapshot = {
      root: { type: 'leaf', leafId: A },
      activeLeafId: B,
      expandedLeafId: B,
      ptyIdsByLeafId: { [A]: 'pty-a' }
    }

    const save = windowSaveForMain(
      stored({ 'tab-1': mains }),
      { terminalLayoutsByTabId: { 'tab-1': windows } },
      'local'
    )

    expect(save.terminalLayoutsByTabId?.['tab-1']).toEqual({ ...windows, root: mains.root })
  })

  it('keeps the window’s tree for a tab main holds no tree of', () => {
    const windows: TerminalLayoutSnapshot = {
      root: { type: 'leaf', leafId: A },
      activeLeafId: A,
      expandedLeafId: null
    }
    const save = { terminalLayoutsByTabId: { 'tab-new': windows } }

    expect(windowSaveForMain(stored({ 'tab-1': mains }), save, 'local')).toBe(save)
  })

  it('passes a save with no pane layouts, or matching trees, through unchanged', () => {
    const noLayouts = { activeWorktreeId: 'wt-1' }
    expect(windowSaveForMain(stored({ 'tab-1': mains }), noLayouts, 'local')).toBe(noLayouts)

    const same = { terminalLayoutsByTabId: { 'tab-1': { ...mains, activeLeafId: B } } }
    expect(windowSaveForMain(stored({ 'tab-1': mains }), same, 'local')).toBe(same)
  })

  it('keeps the window’s trees in a paired server’s partition, where main applies no pane command', () => {
    const save = {
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf' as const, leafId: A },
          activeLeafId: A,
          expandedLeafId: null
        }
      }
    }

    expect(windowSaveForMain(stored({ 'tab-1': mains }), save, 'runtime:env-1')).toBe(save)
    expect(windowSaveForMain(stored({ 'tab-1': mains }), save, 'ssh:target-1')).not.toBe(save)
  })
})

describe('pane trees main writes itself', () => {
  it('a Codex restart of a rootless pane: main wrote the one-pane tree the window then writes', () => {
    const session = {
      activeRepoId: null,
      activeWorktreeId: 'wt-1',
      activeTabId: 'tab-1',
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-1',
            ptyId: 'pty-old',
            worktreeId: 'wt-1',
            title: 'codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: null,
          activeLeafId: A,
          expandedLeafId: null,
          ptyIdsByLeafId: { [A]: 'pty-old' }
        }
      }
    } satisfies WorkspaceSessionState

    // The replacement's spawn binds before it replies (detached-pane-account-restart.ts).
    applyPtyBinding(
      {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: A,
        ptyId: 'pty-new',
        placement: { kind: 'root' }
      },
      session,
      'wt-1',
      `tab-1:${A}`
    )
    // The window's rebind: singlePaneLayoutSnapshot(A, 'pty-new').
    const windows: TerminalLayoutSnapshot = {
      root: { type: 'leaf', leafId: A },
      activeLeafId: A,
      expandedLeafId: null,
      ptyIdsByLeafId: { [A]: 'pty-new' }
    }

    const save = windowSaveForMain(
      session,
      { terminalLayoutsByTabId: { 'tab-1': windows } },
      'local'
    )

    expect(session.terminalLayoutsByTabId['tab-1']?.root).toEqual(windows.root)
    expect(save.terminalLayoutsByTabId?.['tab-1']).toEqual(windows)
  })
})
