import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { keepsExitedPane } from './exited-split-pane-layout-close'

const WORKTREE = 'repo-1::/w'
const TAB = 'tab-1'
const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'

function splitSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: WORKTREE,
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: TAB,
          ptyId: 'pty-left',
          worktreeId: WORKTREE,
          title: 'Terminal 1',
          defaultTitle: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEFT },
          second: { type: 'leaf', leafId: RIGHT }
        },
        activeLeafId: RIGHT,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEFT]: 'pty-left', [RIGHT]: 'pty-right' }
      }
    }
  }
}

const cleanExit = {
  exitCode: 0,
  freshSpawn: false,
  inputSeen: true,
  outputSeen: true,
  shown: true
}
const right = { worktreeId: WORKTREE, parentTabId: TAB, leafId: RIGHT, ptyId: 'pty-right' }

describe('keepsExitedPane', () => {
  it('leaves a split pane whose shell exited cleanly to the retirement', () => {
    expect(keepsExitedPane(splitSession(), right, cleanExit)).toBe(false)
  })

  it('keeps a split pane on a negative code, host-confirmed or not, for recovery', () => {
    expect(keepsExitedPane(splitSession(), right, { ...cleanExit, exitCode: -1 })).toBe(true)
  })

  it('keeps a split pane whose process failed behind its card', () => {
    const session = splitSession()
    expect(
      keepsExitedPane(session, right, {
        ...cleanExit,
        exitCode: 1
      })
    ).toBe(true)
  })

  it('leaves a tab’s last pane, and a pane another terminal took, to the retirement', () => {
    const session = splitSession()
    expect(keepsExitedPane(session, { ...right, ptyId: 'pty-old' }, cleanExit)).toBe(false)
    const lone: WorkspaceSessionState = {
      ...session,
      terminalLayoutsByTabId: {
        [TAB]: {
          root: { type: 'leaf', leafId: RIGHT },
          activeLeafId: RIGHT,
          expandedLeafId: null,
          ptyIdsByLeafId: { [RIGHT]: 'pty-right' }
        }
      }
    }
    expect(keepsExitedPane(lone, right, cleanExit)).toBe(false)
  })

  it('keeps a tab’s last pane behind its card when its process failed or died unused', () => {
    const session = splitSession()
    const lone: WorkspaceSessionState = {
      ...session,
      terminalLayoutsByTabId: {
        [TAB]: {
          root: { type: 'leaf', leafId: RIGHT },
          activeLeafId: RIGHT,
          expandedLeafId: null,
          ptyIdsByLeafId: { [RIGHT]: 'pty-right' }
        }
      }
    }
    const exit = (facts: Partial<typeof cleanExit>) =>
      keepsExitedPane(lone, right, {
        ...cleanExit,
        ...facts
      })
    expect(exit({ exitCode: 1 })).toBe(true)
    expect(exit({ freshSpawn: true, inputSeen: false, shown: false })).toBe(true)
    expect(exit({ freshSpawn: true, inputSeen: true })).toBe(false)
  })
})
