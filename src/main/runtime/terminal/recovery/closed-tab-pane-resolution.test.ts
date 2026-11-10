import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import {
  LEAF_ID,
  PTY_ID,
  TAB_ID,
  WORKTREE_ID
} from '../../__fixtures__/orca-runtime-terminal-close-continuity-state-fixture'
import { createHarness } from '../../__fixtures__/orca-runtime-terminal-close-continuity-fixtures'

// #9194: a paired client asks for a pane by key; a tab the host closed after its agent exited must
// read as gone, or the client keeps the closed tab forever.
async function exitedPaneWithoutTab() {
  const harness = createHarness({ publishMobileSurface: true, registerPtyBacked: true })
  harness.runtime.setNotifier(null)
  harness.syncEmptyGraph()
  harness.removeVictimFromInventory()
  const before = harness.getSession()
  // With no desktop window, the exit itself closes the tab's last pane and so the tab.
  await harness.runtime.onPtyExit(PTY_ID, 0)
  expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
  return { harness, before }
}

const resolve = (harness: Awaited<ReturnType<typeof exitedPaneWithoutTab>>['harness']) =>
  harness.runtime.resolveTerminalPane(makePaneKey(TAB_ID, LEAF_ID), WORKTREE_ID)

describe('resolving a pane of a tab the host closed', () => {
  it('answers terminal_not_found once the exited pane has no tab', async () => {
    const { harness } = await exitedPaneWithoutTab()
    expect(() => resolve(harness)).toThrow('terminal_not_found')
  })

  it('still resolves an exited pane whose tab the host keeps', async () => {
    const { harness, before } = await exitedPaneWithoutTab()
    harness.editSession(() => before)
    expect(resolve(harness)).toMatchObject({ connected: false })
  })

  it('still resolves the pane while the host session is unreadable', async () => {
    const { harness } = await exitedPaneWithoutTab()
    harness.makeSessionUnavailable()
    expect(resolve(harness)).toMatchObject({ connected: false })
  })
})
