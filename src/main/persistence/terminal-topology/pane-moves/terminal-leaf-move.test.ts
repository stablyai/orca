import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { planTerminalLeafMove } from './terminal-leaf-move'

const WT = 'repo::/wt'
const LEFT = '11111111-1111-4111-8111-111111111111'
const MOVED = '22222222-2222-4222-8222-222222222222'

function splitSession(movedTitle?: string): WorkspaceSessionState {
  const session = getDefaultWorkspaceSession()
  return {
    ...session,
    tabsByWorktree: {
      [WT]: [
        {
          id: 'source',
          worktreeId: WT,
          ptyId: 'pty-left',
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      source: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEFT },
          second: { type: 'leaf', leafId: MOVED }
        },
        activeLeafId: MOVED,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEFT]: 'pty-left', [MOVED]: 'pty-moved' },
        ...(movedTitle ? { titlesByLeafId: { [MOVED]: movedTitle } } : {})
      }
    }
  }
}

function plannedTargetTab(session: WorkspaceSessionState) {
  const planned = planTerminalLeafMove([{ hostId: LOCAL_EXECUTION_HOST_ID, session }], {
    worktreeId: WT,
    sourceTabId: 'source',
    targetTabId: 'target',
    leafId: MOVED,
    ptyId: 'pty-moved'
  })
  expect(planned.result).toEqual({ status: 'moved', ptyId: 'pty-moved' })
  return planned.sessions[0]?.session.tabsByWorktree[WT]?.find((tab) => tab.id === 'target')
}

describe('committing a pane move to a new tab', () => {
  it('names the new tab after the pane in the same write that creates it', () => {
    expect(plannedTargetTab(splitSession('  build watcher '))?.customTitle).toBe('build watcher')
  })

  it('leaves the new tab unnamed when the pane has no title', () => {
    expect(plannedTargetTab(splitSession())?.customTitle ?? null).toBeNull()
  })
})
