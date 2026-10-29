import { describe, expect, it, vi } from 'vitest'
import { windowViewSaveForMain } from './window-save-view'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { parseWorkspaceSession } from '../../shared/workspace-session-schema'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const FIELD = 'closedTerminalPanesByPaneKey'
const session: WorkspaceSessionState = {
  ...getDefaultWorkspaceSession(),
  closedTerminalPanesByPaneKey: {
    'tab-1:leaf-1': { ptyId: 'pty-1', incarnationId: 'inc-1', worktreeId: 'repo::/w', closedAt: 1 }
  }
}

describe('main’s closed-pane record', () => {
  it('survives this build’s session parse', () => {
    const parsed = parseWorkspaceSession(session)
    expect(parsed.ok && parsed.value.closedTerminalPanesByPaneKey).toEqual(
      session.closedTerminalPanesByPaneKey
    )
  })

  it('is not written by a window save that leaves a bound tab out', () => {
    const leaf = '11111111-1111-4111-8111-111111111111'
    const stored: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        'repo::/w': [
          {
            id: 'tab-1',
            ptyId: 'pty-1',
            worktreeId: 'repo::/w',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: leaf },
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf]: 'pty-1' }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [`tab-1:${leaf}`]: 'inc-1' }
    }
    const save = { ...stored, tabsByWorktree: { 'repo::/w': [] }, terminalLayoutsByTabId: {} }

    expect(windowViewSaveForMain(stored, save, 'local')).not.toHaveProperty(FIELD)
  })
})
