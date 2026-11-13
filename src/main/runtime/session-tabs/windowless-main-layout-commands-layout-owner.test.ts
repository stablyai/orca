// Layout-owner build, no window: a CLI close, rename or pane title, and a phone's tab props or pane
// names, of a workspace main owns are each main's own layout command, published as one frame.
import { describe, expect, it, vi } from 'vitest'
import {
  LEAF_A,
  LEAF_B,
  PTY_A,
  TAB_ID,
  WORKTREE_ID,
  setupMainOwnedWorkspace
} from '../terminal/layout/main-owned-workspace-runtime-fixture'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

/** Runs one operation and counts the layout frames it published. */
async function framesOf(
  fixture: ReturnType<typeof setupMainOwnedWorkspace>,
  operation: () => Promise<unknown>
): Promise<number> {
  const before = fixture.frames()
  await operation()
  await Promise.resolve()
  return fixture.frames() - before
}

const tabRow = (fixture: ReturnType<typeof setupMainOwnedWorkspace>) =>
  fixture.session().tabsByWorktree[WORKTREE_ID]?.find((tab) => tab.id === TAB_ID)

describe('CLI terminal commands on a workspace main owns, with no window', () => {
  it('closes the tab in one frame', async () => {
    const fixture = setupMainOwnedWorkspace()
    const handle = fixture.handleOf(PTY_A)

    expect(await framesOf(fixture, () => fixture.runtime.closeTerminalTab(handle))).toBe(1)

    expect(tabRow(fixture)).toBeUndefined()
    expect(fixture.stopped).toEqual([PTY_A])
  })
})

describe("a phone's tab props and pane names on a workspace main owns, with no window", () => {
  it('names only the panes the phone says it renamed', async () => {
    const fixture = setupMainOwnedWorkspace({ split: true })
    const root = fixture.session().terminalLayoutsByTabId[TAB_ID]!.root

    await fixture.runtime.updateMobileSessionPaneLayout(`id:${WORKTREE_ID}`, {
      tabId: TAB_ID,
      root,
      expandedLeafId: null,
      titlesByLeafId: { [LEAF_A]: 'Stale', [LEAF_B]: 'Server' },
      renamedLeafIds: [LEAF_B]
    })

    expect(fixture.session().terminalLayoutsByTabId[TAB_ID]?.titlesByLeafId).toEqual({
      [LEAF_B]: 'Server'
    })
  })
})
