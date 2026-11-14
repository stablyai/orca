// Paired close uses session.tabs.close to stop host terminals; window-style layout.apply assumes its window already stopped them.
import { describe, expect, it, vi } from 'vitest'
import {
  PTY_A,
  TAB_ID,
  WORKTREE_ID,
  setupMainOwnedWorkspace
} from './main-owned-workspace-runtime-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

type Fixture = ReturnType<typeof setupMainOwnedWorkspace>

const tabRow = (fixture: Fixture) =>
  fixture.session().tabsByWorktree[WORKTREE_ID]?.find((tab) => tab.id === TAB_ID)

/** session.tabs.close as the desktop sends it: the host tab id, a user reason, no force. */
const desktopClose = (fixture: Fixture) =>
  fixture.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, {
    reason: 'user',
    clientNavigationId: 'paired-desktop'
  })

// This harness has no renderer publication, so only main-owned session rows exist.
describe('a paired desktop’s close of a tab a server’s main owns, with no window', () => {
  it('closes the tab in main’s layout and stops its terminal', async () => {
    const fixture = setupMainOwnedWorkspace()

    await desktopClose(fixture)

    expect(tabRow(fixture)).toBeUndefined()
    expect(fixture.stopped).toEqual([PTY_A])
  })

  it('refuses a pinned tab, keeping it and its terminal', async () => {
    const fixture = setupMainOwnedWorkspace({ pinned: true })

    await expect(desktopClose(fixture)).rejects.toThrow('terminal_tab_pinned')

    expect(tabRow(fixture)).toBeDefined()
    expect(fixture.stopped).toEqual([])
  })
})
