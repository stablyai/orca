import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { evaluatePtyBindingFastLane } from './pty-binding-fast-lane'

const LEAF = '11111111-1111-4111-8111-111111111111'
const WORKTREE = 'repo1::/worktree'
const request = { tabId: 'tab1', leafId: LEAF, ptyId: 'pty-1' }
const paneKey = `tab1:${LEAF}`

function session(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: 'tab1',
          worktreeId: WORKTREE,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ptyId: 'pty-1'
        }
      ]
    },
    terminalLayoutsByTabId: {
      tab1: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty-1' }
      }
    },
    ...overrides
  }
}

describe('evaluatePtyBindingFastLane', () => {
  it('is eligible only when memory matches and the session is durable', () => {
    expect(evaluatePtyBindingFastLane(request, session(), WORKTREE, true)).toEqual({
      eligible: true,
      misses: []
    })
    expect(evaluatePtyBindingFastLane(request, session(), WORKTREE, false)).toEqual({
      eligible: false,
      misses: ['not_durable']
    })
  })

  it('names every miss', () => {
    const miss = (
      args: Partial<Parameters<typeof evaluatePtyBindingFastLane>[0]>,
      state: WorkspaceSessionState = session()
    ) => evaluatePtyBindingFastLane({ ...request, ...args }, state, WORKTREE, true).misses

    expect(miss({ expectedSourceBinding: {} })).toEqual(['split'])
    expect(miss({ leafId: 'legacy-pane-1' })).toEqual(['legacy_leaf', 'leaf_absent', 'leaf_pty'])
    expect(miss({}, session({ tabsByWorktree: {} }))).toEqual(['tab_missing'])
    expect(miss({ ptyId: 'pty-2' })).toEqual(['tab_pty', 'leaf_pty'])
    expect(miss({}, session({ terminalLayoutsByTabId: {} }))).toEqual(['layout_missing'])
    expect(
      miss(
        {},
        session({
          terminalLayoutsByTabId: {
            tab1: { root: null, activeLeafId: null, expandedLeafId: null, ptyIdsByLeafId: {} }
          }
        })
      )
    ).toEqual(['layout_missing'])
    expect(miss({ incarnationId: 'a' })).toEqual(['incarnation'])
    expect(miss({}, session({ terminalPtyIncarnationsByPaneKey: { [paneKey]: 'a' } }))).toEqual([
      'incarnation'
    ])
    expect(
      miss(
        { incarnationId: 'b', expectedBinding: { ptyId: 'pty-1', incarnationId: 'a' } },
        session({ terminalPtyIncarnationsByPaneKey: { [paneKey]: 'b' } })
      )
    ).toEqual(['reconciled'])
    expect(
      miss(
        { incarnationId: 'a' },
        session({
          terminalPtyIncarnationsByPaneKey: { [paneKey]: 'a' },
          terminalSurfaceTombstonesByPaneKey: {
            [paneKey]: {
              worktreeId: WORKTREE,
              parentTabId: 'tab1',
              leafId: LEAF,
              ptyId: 'pty-1',
              incarnationId: 'a',
              retiredAt: 1
            }
          }
        })
      )
    ).toEqual(['tombstone'])
  })

  it('accepts a sibling pane whose tab row names the first pane', () => {
    const LEAF_B = '22222222-2222-4222-8222-222222222222'
    const state = session({
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: LEAF },
            second: { type: 'leaf', leafId: LEAF_B }
          },
          activeLeafId: LEAF_B,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: 'pty-1', [LEAF_B]: 'pty-2' }
        }
      }
    })
    expect(
      evaluatePtyBindingFastLane(
        { ...request, leafId: LEAF_B, ptyId: 'pty-2' },
        state,
        WORKTREE,
        true
      )
    ).toEqual({ eligible: true, misses: [] })
  })

  it('accepts a matching incarnation and a reconciled-to-same expected binding', () => {
    const state = session({ terminalPtyIncarnationsByPaneKey: { [paneKey]: 'a' } })
    expect(
      evaluatePtyBindingFastLane(
        { ...request, incarnationId: 'a', expectedBinding: { ptyId: 'pty-1', incarnationId: 'a' } },
        state,
        WORKTREE,
        true
      ).eligible
    ).toBe(true)
  })
})
