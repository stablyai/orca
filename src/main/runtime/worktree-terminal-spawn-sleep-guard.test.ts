import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  indexPersistedPtyPaneBindings,
  indexPersistedPtySurfaceBindings
} from './runtime-worktree-binding-index'
import {
  blocksAutomaticTerminalSpawnForSleep,
  captureTerminalSleepPanes,
  type WorktreeTerminalSleepState
} from './worktree-terminal-spawn-sleep-guard'

const WORKTREE = 'repo::/tmp/sleep-workspace'
const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'
const PANE = makePaneKey('tab', LEAF)

function savedSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: 'tab',
          ptyId: 'stopped',
          worktreeId: WORKTREE,
          title: 'Shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      tab: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'stopped' }
      }
    }
  }
}

function partialState(): WorktreeTerminalSleepState {
  return {
    worktreeId: WORKTREE,
    generation: 1,
    phase: 'partial',
    ptyIds: ['stopped'],
    terminalHandles: [],
    terminalHandlesByPtyId: { stopped: [], cancelled: [] },
    paneKeysByPtyId: {}
  }
}

describe('sleep pane identity capture', () => {
  it('captures a saved pane address without promoting incarnation ownership', () => {
    const session = savedSession()
    expect(indexPersistedPtyPaneBindings(session).get('stopped')?.paneKey).toBe(PANE)
    expect(indexPersistedPtySurfaceBindings(session).size).toBe(0)
    expect(captureTerminalSleepPanes(['stopped'], new Map(), session, WORKTREE)).toEqual({
      stopped: PANE
    })
    expect(captureTerminalSleepPanes(['stopped'], new Map(), session, 'other::/tmp/other')).toEqual(
      {}
    )
  })

  it('keeps incarnation-required indexing strict when a stale duplicate has no incarnation', () => {
    const session = savedSession()
    const first = session.tabsByWorktree[WORKTREE]?.[0]
    if (!first) {
      throw new Error('Missing fixture tab')
    }
    session.terminalPtyIncarnationsByPaneKey = { [PANE]: 'incarnation-1' }
    session.tabsByWorktree[WORKTREE]?.push({ ...first, id: 'stale' })
    session.terminalLayoutsByTabId.stale = {
      root: { type: 'leaf', leafId: OTHER_LEAF },
      activeLeafId: OTHER_LEAF,
      expandedLeafId: null,
      ptyIdsByLeafId: { [OTHER_LEAF]: 'stopped' }
    }
    expect(indexPersistedPtyPaneBindings(session).has('stopped')).toBe(false)
    expect(indexPersistedPtySurfaceBindings(session).get('stopped')).toMatchObject({
      paneKey: PANE,
      incarnationId: 'incarnation-1'
    })
    session.terminalPtyIncarnationsByPaneKey[makePaneKey('stale', OTHER_LEAF)] = 'incarnation-2'
    expect(indexPersistedPtySurfaceBindings(session).has('stopped')).toBe(false)
  })

  it('fails closed for an unknown committed pane but permits a known cancelled PTY', () => {
    const state = partialState()
    expect(
      blocksAutomaticTerminalSpawnForSleep(state, { ptyId: 'new-pty', paneKey: 'unknown' })
    ).toBe(true)
    expect(blocksAutomaticTerminalSpawnForSleep(state, { ptyId: 'cancelled' })).toBe(false)
    state.paneKeysByPtyId.cancelled = 'cancelled:leaf'
    expect(blocksAutomaticTerminalSpawnForSleep(state, { paneKey: 'cancelled:leaf' })).toBe(false)
    expect(blocksAutomaticTerminalSpawnForSleep(state, { ptyId: 'stopped' })).toBe(true)
  })
})
