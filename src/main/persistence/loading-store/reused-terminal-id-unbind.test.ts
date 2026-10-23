// L80 (P2): a spawn commit binding a reused local terminal id leaves no other pane naming it.
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

const switchState = vi.hoisted(() => ({ on: true }))
vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return switchState.on
  }
}))

const { applyPtyBinding } = await import('./pty-binding-session-update')

const WORKTREE = 'repo-1::/fixture/worktree'
const SAVED_LEAF = '11111111-1111-4111-8111-111111111111'
const NEW_LEAF = '22222222-2222-4222-8222-222222222222'

/** A pane saved before a restart, bound to local id `pty-3`, stamped (or not) with its process. */
function savedSession(stamp: string | null): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: 'saved-tab',
          ptyId: 'pty-3',
          worktreeId: WORKTREE,
          title: 'Saved',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'saved-tab': {
        root: { type: 'leaf', leafId: SAVED_LEAF },
        activeLeafId: SAVED_LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [SAVED_LEAF]: 'pty-3' }
      }
    },
    ...(stamp ? { terminalPtyIncarnationsByPaneKey: { [`saved-tab:${SAVED_LEAF}`]: stamp } } : {})
  }
}

/** The new terminal's spawn commit: id `pty-3` again, under a new incarnation, in a new tab. */
function bindNewTerminal(session: WorkspaceSessionState): void {
  applyPtyBinding(
    {
      worktreeId: WORKTREE,
      tabId: 'new-tab',
      leafId: NEW_LEAF,
      ptyId: 'pty-3',
      incarnationId: 'inc-now'
    },
    session,
    WORKTREE,
    `new-tab:${NEW_LEAF}`
  )
}

function panesBinding(session: WorkspaceSessionState, ptyId: string): string[] {
  return Object.entries(session.terminalLayoutsByTabId).flatMap(([tabId, layout]) =>
    Object.entries(layout.ptyIdsByLeafId ?? {})
      .filter(([, bound]) => bound === ptyId)
      .map(([leafId]) => `${tabId}:${leafId}`)
  )
}

describe('a spawn commit binding a reused terminal id (switch on)', () => {
  it('unbinds the id from a saved pane stamped with another incarnation, in the same write', () => {
    switchState.on = true
    const session = savedSession('inc-before-restart')

    bindNewTerminal(session)

    expect(panesBinding(session, 'pty-3')).toEqual([`new-tab:${NEW_LEAF}`])
    expect(session.terminalPtyIncarnationsByPaneKey).toEqual({ [`new-tab:${NEW_LEAF}`]: 'inc-now' })
    // The saved pane stays, bound to nothing, and its tab row no longer names the id.
    expect(session.terminalLayoutsByTabId['saved-tab']?.root).toEqual({
      type: 'leaf',
      leafId: SAVED_LEAF
    })
    expect(session.tabsByWorktree[WORKTREE]?.find((tab) => tab.id === 'saved-tab')?.ptyId).toBe(
      null
    )
  })

  it('leaves every saved binding as it was for a spawn of an id no pane names', () => {
    switchState.on = true
    const session = savedSession('inc-before-restart')
    const before = structuredClone(session)

    applyPtyBinding(
      {
        worktreeId: WORKTREE,
        tabId: 'new-tab',
        leafId: NEW_LEAF,
        ptyId: 'pty-4',
        incarnationId: 'inc-4'
      },
      session,
      WORKTREE,
      `new-tab:${NEW_LEAF}`
    )

    expect(session.terminalLayoutsByTabId['saved-tab']).toEqual(
      before.terminalLayoutsByTabId['saved-tab']
    )
    expect(session.tabsByWorktree[WORKTREE]?.[0]).toEqual(before.tabsByWorktree[WORKTREE]?.[0])
    expect(session.terminalPtyIncarnationsByPaneKey).toEqual({
      [`saved-tab:${SAVED_LEAF}`]: 'inc-before-restart',
      [`new-tab:${NEW_LEAF}`]: 'inc-4'
    })
  })

  it('moves the tab row to the pane still bound when the stale pane is a split of the same tab', () => {
    switchState.on = true
    const session = savedSession('inc-before-restart')
    session.terminalLayoutsByTabId['saved-tab'] = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: SAVED_LEAF },
        second: { type: 'leaf', leafId: NEW_LEAF }
      },
      activeLeafId: SAVED_LEAF,
      expandedLeafId: null,
      ptyIdsByLeafId: { [SAVED_LEAF]: 'pty-3' }
    }

    applyPtyBinding(
      {
        worktreeId: WORKTREE,
        tabId: 'saved-tab',
        leafId: NEW_LEAF,
        ptyId: 'pty-3',
        incarnationId: 'inc-now'
      },
      session,
      WORKTREE,
      `saved-tab:${NEW_LEAF}`
    )

    expect(panesBinding(session, 'pty-3')).toEqual([`saved-tab:${NEW_LEAF}`])
    expect(session.tabsByWorktree[WORKTREE]?.[0]?.ptyId).toBe('pty-3')
    expect(session.terminalPtyIncarnationsByPaneKey).toEqual({
      [`saved-tab:${NEW_LEAF}`]: 'inc-now'
    })
  })

  it('leaves a pane stamped with the same incarnation bound', () => {
    switchState.on = true
    const session = savedSession('inc-now')

    bindNewTerminal(session)

    expect(panesBinding(session, 'pty-3').sort()).toEqual(
      [`new-tab:${NEW_LEAF}`, `saved-tab:${SAVED_LEAF}`].sort()
    )
  })

  // Known limit: a legacy save has no stamp, so nothing proves it names another process.
  it('leaves an unstamped saved binding alone', () => {
    switchState.on = true
    const session = savedSession(null)

    bindNewTerminal(session)

    expect(panesBinding(session, 'pty-3').sort()).toEqual(
      [`new-tab:${NEW_LEAF}`, `saved-tab:${SAVED_LEAF}`].sort()
    )
  })

  it('changes nothing with the switch off', () => {
    switchState.on = false
    const session = savedSession('inc-before-restart')

    bindNewTerminal(session)

    expect(panesBinding(session, 'pty-3').sort()).toEqual(
      [`new-tab:${NEW_LEAF}`, `saved-tab:${SAVED_LEAF}`].sort()
    )
    switchState.on = true
  })
})
