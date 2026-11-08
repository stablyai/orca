// Layout-owner build, no window: an agent launch's early tab in a workspace main owns is written by
// main, a retry finds it, and a withdrawn launch pane is taken back by main.
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  WORKTREE_ID,
  setupMainOwnedWorkspace
} from '../terminal/layout/main-owned-workspace-runtime-fixture'

import { publishAgentLaunchTabEarly } from '../rpc/methods/agent-launch/agent-launch-tab-publication'

import { resetAgentLaunchPanesForTests } from '../../agent-launch/agent-launch-pane-attachment'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const NEW_TAB = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const NEW_LEAF = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

afterEach(() => resetAgentLaunchPanesForTests())

function launchHost() {
  const fixture = setupMainOwnedWorkspace()
  Object.assign(fixture.runtime, {
    showTerminalWorkspaceLaunchScope: async () => ({ id: WORKTREE_ID, path: '/workspace' })
  })
  const context = { runtime: fixture.runtime }
  const launch = () =>
    publishAgentLaunchTabEarly(
      {
        agent: 'claude',
        target: { kind: 'existing', worktree: `id:${WORKTREE_ID}` },
        paneKey: `${NEW_TAB}:${NEW_LEAF}`,
        surface: 'terminal'
      },
      context
    )
  const tabIds = () => fixture.session().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id) ?? []
  return { fixture, launch, tabIds }
}

describe("an agent launch's early tab in a workspace main owns, with no window", () => {
  it('takes the tab back when nothing will run in it', async () => {
    const { launch, tabIds } = launchHost()

    const early = await launch()
    // Never admitted: the launch made this tab, and nothing will ever run in it.
    early?.finish('agent_launch_refused')
    await vi.waitFor(() => expect(tabIds()).not.toContain(NEW_TAB))
  })

  it('keeps a tab a retry found, since that launch made none', async () => {
    const { launch, tabIds } = launchHost()

    await launch()
    resetAgentLaunchPanesForTests()
    const retry = await launch()
    retry?.finish('agent_launch_refused')
    await Promise.resolve()

    expect(tabIds()).toContain(NEW_TAB)
  })
})
