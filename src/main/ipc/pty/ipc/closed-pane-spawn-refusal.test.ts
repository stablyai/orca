import { describe, expect, it } from 'vitest'
import { refuseClosedPaneSpawn } from './closed-pane-spawn-refusal'
import { fenceExitClosedPane } from '../../../persistence/terminal-topology/pane-ownership/closed-pane-binding-fence'
import {
  isClosedPaneRefusal,
  unboundSpawnOutcome
} from '../../../../shared/workspace-layout/closed-pane-spawn-refusal'

const TAB = 'tab_c'
const LEAF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function storeHolding(leafIds: string[]): Parameters<typeof refuseClosedPaneSpawn>[0] {
  const root = leafIds.length === 0 ? null : { type: 'leaf' as const, leafId: leafIds[0] }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refusal reads only these two store methods.
  return {
    getWorkspaceSessionHostIds: () => ['local'],
    getWorkspaceSession: () => ({ terminalLayoutsByTabId: { [TAB]: { root } } })
  } as never
}

describe('a window start into a pane main closed', () => {
  it('is refused, and the window pane waits for main to drop it instead of remounting', () => {
    fenceExitClosedPane(`${TAB}:${LEAF}`)
    let message = ''
    try {
      refuseClosedPaneSpawn(storeHolding([]), TAB, LEAF)
    } catch (error) {
      // As the window reads it back from the spawn IPC.
      message = `Error invoking remote method 'pty:spawn': ${String(error)}`
    }
    expect(isClosedPaneRefusal(message)).toBe(true)
    expect(unboundSpawnOutcome({ ownerRefused: false, paneClosed: true, deferred: false })).toBe(
      'wait'
    )
  })

  it('still starts a fenced pane main holds again', () => {
    fenceExitClosedPane(`${TAB}:${LEAF}`)
    expect(() => refuseClosedPaneSpawn(storeHolding([LEAF]), TAB, LEAF)).not.toThrow()
  })
})
