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
} from './main-owned-workspace-runtime-fixture'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

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

  it('renames the tab in one frame, as a manual name later agent titles do not override', async () => {
    const fixture = setupMainOwnedWorkspace()
    const handle = fixture.handleOf(PTY_A)

    expect(await framesOf(fixture, () => fixture.runtime.renameTerminal(handle, 'Build'))).toBe(1)

    expect(tabRow(fixture)?.customTitle).toBe('Build')
    expect(fixture.ptyRecord(PTY_A)).toMatchObject({ title: 'Build' })
    expect(fixture.ptyRecord(PTY_A)?.titleUpdatedAt).toEqual(expect.any(Number))
  })

  it('names one pane in one frame', async () => {
    const fixture = setupMainOwnedWorkspace({ split: true })
    const handle = fixture.handleOf(PTY_A)

    expect(await framesOf(fixture, () => fixture.runtime.setPaneTitle(handle, ' Logs '))).toBe(1)

    expect(fixture.session().terminalLayoutsByTabId[TAB_ID]?.titlesByLeafId).toEqual({
      [LEAF_A]: 'Logs'
    })
    expect(tabRow(fixture)?.customTitle).toBeNull()
  })
})

describe("a phone's tab props and pane names on a workspace main owns, with no window", () => {
  it('renames the tab in main and stamps its live terminal', async () => {
    const fixture = setupMainOwnedWorkspace()

    await fixture.runtime.setMobileSessionTabProps(`id:${WORKTREE_ID}`, {
      tabId: TAB_ID,
      customTitle: ' Deploy '
    })

    expect(tabRow(fixture)?.customTitle).toBe('Deploy')
    expect(fixture.ptyRecord(PTY_A)?.titleUpdatedAt).toEqual(expect.any(Number))
  })

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

describe('the same commands with a window open', () => {
  /** A window whose own rename relays would answer; main must not hand them the change. */
  function withWindow(fixture: ReturnType<typeof setupMainOwnedWorkspace>) {
    const notifier = { renameTerminal: vi.fn(), setPaneTitle: vi.fn(() => true) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these commands reach only these two notices.
    fixture.runtime.setNotifier(notifier as never)
    Object.assign(fixture.runtime, { getAvailableAuthoritativeWindow: () => ({}) })
    return notifier
  }

  it("renames the tab in main's layout and relays nothing to the window", async () => {
    const fixture = setupMainOwnedWorkspace()
    const notifier = withWindow(fixture)

    await fixture.runtime.renameTerminal(fixture.handleOf(PTY_A), 'Build')

    expect(tabRow(fixture)?.customTitle).toBe('Build')
    expect(notifier.renameTerminal).not.toHaveBeenCalled()
  })
})
