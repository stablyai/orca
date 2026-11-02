// Layout-owner build: a phone's close of a terminal row main owns, with no window, is main's own
// layout close; a pinned tab stays unless the phone forces the close, as the window-era close did.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resetAgentLaunchPanesForTests,
  resolveAgentLaunchPaneVerdict,
  trackRunningAgentLaunchPane
} from '../../../agent-launch/agent-launch-pane-attachment'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  LEAF_A,
  LEAF_B,
  PTY_A,
  PTY_B,
  TAB_ID,
  WORKTREE_ID,
  setupMainOwnedWorkspace
} from '../../main-owned-workspace-runtime-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const tabsOf = (fixture: ReturnType<typeof setupMainOwnedWorkspace>) =>
  fixture.session().tabsByWorktree[WORKTREE_ID] ?? []

describe("a phone's terminal close in a workspace main owns, with no window", () => {
  afterEach(() => resetAgentLaunchPanesForTests())

  it('closes the tab in main, records the close, and stops its terminal', async () => {
    const fixture = setupMainOwnedWorkspace()

    await fixture.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, { reason: 'user' })

    expect(tabsOf(fixture)).toHaveLength(0)
    expect(fixture.session().closedTerminalTabTombstonesByTabId?.[TAB_ID]).toMatchObject({
      reason: 'user'
    })
    expect(fixture.stopped).toEqual([PTY_A])
  })

  it('closes one pane of a split and stops only its terminal', async () => {
    const fixture = setupMainOwnedWorkspace({ split: true })

    await fixture.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, `${TAB_ID}::${LEAF_B}`)

    expect(tabsOf(fixture)).toHaveLength(1)
    expect(fixture.session().terminalLayoutsByTabId[TAB_ID]?.root).toEqual({
      type: 'leaf',
      leafId: LEAF_A
    })
    expect(fixture.stopped).toEqual([PTY_B])
  })

  it('refuses a pinned tab and keeps it and its terminal', async () => {
    const fixture = setupMainOwnedWorkspace({ pinned: true })

    await expect(
      fixture.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, { reason: 'user' })
    ).rejects.toThrow('terminal_tab_pinned')

    expect(tabsOf(fixture)).toHaveLength(1)
    expect(fixture.stopped).toEqual([])
  })

  it('leaves a launch running in a pinned tab it refused to close to finish into the tab', async () => {
    const fixture = setupMainOwnedWorkspace({ pinned: true })
    const pane = { worktreeId: WORKTREE_ID, paneKey: makePaneKey(TAB_ID, LEAF_A) }
    const launch = trackRunningAgentLaunchPane(pane)

    await expect(
      fixture.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, { reason: 'user' })
    ).rejects.toThrow('terminal_tab_pinned')

    // The launch is not told its tab closed, so it does not take its pane back...
    expect(launch.closedByUser()).toBe(false)
    launch.finish({ kind: 'not-started', code: 'agent_exited' })
    // ...and its failure stays for the pane, which is still there, to show.
    await expect(resolveAgentLaunchPaneVerdict(pane, () => false)).resolves.toEqual({
      kind: 'not-started',
      code: 'agent_exited'
    })
    expect(tabsOf(fixture)).toHaveLength(1)
  })

  it('closes a pinned tab the phone forces', async () => {
    const fixture = setupMainOwnedWorkspace({ pinned: true })

    await fixture.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, {
      reason: 'user',
      force: true
    })

    expect(tabsOf(fixture)).toHaveLength(0)
    expect(fixture.stopped).toEqual([PTY_A])
  })
})
