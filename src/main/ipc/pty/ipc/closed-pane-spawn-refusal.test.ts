import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { Store } from '../../../persistence'
import {
  _resetClosedPaneFencesForTests,
  fencedIfLayoutOwner,
  partitionsFence
} from '../../../persistence/terminal-topology/closed-pane-binding-fence'
import { refuseClosedPaneSpawn } from './closed-pane-spawn-refusal'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

function session(leafIds: string[]): WorkspaceSessionState {
  const [first, second] = leafIds
  return {
    ...getDefaultWorkspaceSession(),
    terminalLayoutsByTabId: {
      t: {
        root: second
          ? {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', leafId: first! },
              second: { type: 'leaf', leafId: second }
            }
          : { type: 'leaf', leafId: first! },
        activeLeafId: first!,
        expandedLeafId: null
      }
    }
  }
}

function storeHolding(current: { value: WorkspaceSessionState }): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: refuseClosedPaneSpawn reads only these two Store members.
  return {
    getWorkspaceSessionHostIds: () => ['local'],
    getWorkspaceSession: () => current.value
  } as unknown as Store
}

describe('a spawn for a pane main closed while it waited', () => {
  afterEach(() => _resetClosedPaneFencesForTests())

  it('starts nothing once main took the pane back', () => {
    const current = { value: session(['a', 'b']) }
    fencedIfLayoutOwner(
      () => partitionsFence(['local'], () => current.value, true),
      () => ((current.value = session(['a'])), { value: null })
    )()

    expect(() => refuseClosedPaneSpawn(storeHolding(current), 't', 'b')).toThrow(
      'terminal_pane_closed'
    )
  })

  it('starts a pane main never closed, or one it holds again', () => {
    const current = { value: session(['a', 'b']) }
    expect(() => refuseClosedPaneSpawn(storeHolding(current), 't', 'b')).not.toThrow()

    fencedIfLayoutOwner(
      () => partitionsFence(['local'], () => current.value, true),
      () => ((current.value = session(['a'])), { value: null })
    )()
    current.value = session(['a', 'b'])
    expect(() => refuseClosedPaneSpawn(storeHolding(current), 't', 'b')).not.toThrow()
  })
})
