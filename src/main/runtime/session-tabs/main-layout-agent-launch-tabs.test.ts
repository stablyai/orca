// Layout-owner build, no window: an agent launch's early tab in a workspace main owns is written by
// main, a retry finds it, and a withdrawn launch pane is taken back by main.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKTREE_ID, setupMainOwnedWorkspace } from '../main-owned-workspace-runtime-fixture'
import { publishAgentLaunchTabEarly } from '../rpc/methods/agent-launch-tab-publication'
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
  it("is written in main's layout before the launch runs", async () => {
    const { fixture, launch, tabIds } = launchHost()

    const early = await launch()

    expect(early?.paneKey).toBe(`${NEW_TAB}:${NEW_LEAF}`)
    expect(tabIds()).toContain(NEW_TAB)
    expect(
      fixture.session().tabsByWorktree[WORKTREE_ID]?.find((tab) => tab.id === NEW_TAB)
    ).toMatchObject({ launchAgent: 'claude' })
  })

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

describe("an agent launch's early tab in a workspace main owns, with a window attached", () => {
  it('is written by main, and the window keeps its pane, prompt and view without making a tab', async () => {
    const { fixture, tabIds } = launchHost()
    const publishAgentLaunchTab = vi.fn(async () => {
      throw new Error('the window makes no tab here')
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the early tab reads only this notice.
    fixture.runtime.setNotifier({ publishAgentLaunchTab } as never)
    Object.assign(fixture.runtime, { getAvailableAuthoritativeWindow: () => ({}) })
    const context = { runtime: fixture.runtime }

    await publishAgentLaunchTabEarly(
      {
        agent: 'claude',
        target: { kind: 'existing', worktree: `id:${WORKTREE_ID}` },
        paneKey: `${NEW_TAB}:${NEW_LEAF}`,
        surface: 'terminal',
        prompt: { text: 'fix the build', delivery: 'submit' },
        operationId: 'op-1'
      },
      context
    )

    expect(tabIds()).toContain(NEW_TAB)
    // Told once main's tab is written, as the window's own publication was answered.
    await vi.waitFor(() =>
      expect(publishAgentLaunchTab).toHaveBeenCalledWith(
        expect.objectContaining({
          tabId: NEW_TAB,
          leafId: NEW_LEAF,
          prompt: 'fix the build',
          operationId: 'op-1',
          viewer: expect.any(String),
          shownByMain: { frameSeq: expect.any(Number), created: true }
        })
      )
    )
  })
})
