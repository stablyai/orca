import { afterEach, describe, expect, it } from 'vitest'
import {
  forgetFailedAgentLaunches,
  markAgentLaunchesClosedByUser,
  resetAgentLaunchPanesForTests,
  resolveAgentLaunchPaneVerdict,
  trackRunningAgentLaunchPane
} from './agent-launch-pane-attachment'

const PANE = { worktreeId: 'wt-1', paneKey: 'tab-1:leaf-1' }
const notLive = (): boolean => false

describe('a pane an agent launch laid out', () => {
  afterEach(() => {
    resetAgentLaunchPanesForTests()
  })

  it('is an ordinary pane when no launch runs for it, as after a restart', () => {
    expect(resolveAgentLaunchPaneVerdict(PANE, notLive)).toBeNull()
  })

  it('waits for the launch running in this process, then says how it ended', async () => {
    const running = trackRunningAgentLaunchPane(PANE)
    const verdict = resolveAgentLaunchPaneVerdict(PANE, notLive)
    expect(verdict).not.toBeNull()

    running.finish({ kind: 'not-started', code: 'agent_session_exited_during_start' })

    await expect(verdict).resolves.toEqual({
      kind: 'not-started',
      code: 'agent_session_exited_during_start'
    })
    // Over, for this process: a later spawn of the pane gets the same answer, never a shell.
    await expect(resolveAgentLaunchPaneVerdict(PANE, notLive)).resolves.toEqual({
      kind: 'not-started',
      code: 'agent_session_exited_during_start'
    })
    // After a restart nothing is left: the pane is an ordinary one.
    resetAgentLaunchPanesForTests()
    expect(resolveAgentLaunchPaneVerdict(PANE, notLive)).toBeNull()
  })

  it('forgets a failed launch once the user closes its pane, or a process holds it', async () => {
    const pane = { worktreeId: 'wt-1', paneKey: 'tab-1:3f2504e0-4f89-41d3-9a0c-0305e82c3301' }
    trackRunningAgentLaunchPane(pane).finish({ kind: 'not-started', code: 'boom' })
    markAgentLaunchesClosedByUser('wt-1', { kind: 'tab', tabId: 'tab-1' })
    expect(resolveAgentLaunchPaneVerdict(pane, notLive)).toBeNull()

    trackRunningAgentLaunchPane(PANE).finish({ kind: 'unconfirmed' })
    await expect(resolveAgentLaunchPaneVerdict(PANE, () => true)).resolves.toEqual({
      kind: 'proceed'
    })
    expect(resolveAgentLaunchPaneVerdict(PANE, notLive)).toBeNull()
  })

  it('keeps no failure for a pane the user closed before its launch ended', () => {
    const pane = { worktreeId: 'wt-1', paneKey: 'tab-1:3f2504e0-4f89-41d3-9a0c-0305e82c3301' }
    const running = trackRunningAgentLaunchPane(pane)
    markAgentLaunchesClosedByUser('wt-1', { kind: 'tab', tabId: 'tab-1' })
    running.finish({ kind: 'not-started', code: 'agent_launch_tab_closed' })
    expect(resolveAgentLaunchPaneVerdict(pane, notLive)).toBeNull()
  })

  it('forgets a failure once its pane moves to another tab or its workspace goes', () => {
    const leafId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    const moved = { worktreeId: 'wt-1', paneKey: `tab-1:${leafId}` }
    const removed = { worktreeId: 'wt-2', paneKey: `tab-2:${leafId}` }
    trackRunningAgentLaunchPane(moved).finish({ kind: 'unconfirmed' })
    trackRunningAgentLaunchPane(removed).finish({ kind: 'not-started', code: 'boom' })

    forgetFailedAgentLaunches('wt-1', { kind: 'pane', tabId: 'tab-1', leafId })
    forgetFailedAgentLaunches('wt-2', null)

    expect(resolveAgentLaunchPaneVerdict(moved, notLive)).toBeNull()
    expect(resolveAgentLaunchPaneVerdict(removed, notLive)).toBeNull()
  })

  it("hears the user's close only while the pane's launch is running", () => {
    const tabId = 'tab-closing'
    const leafId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    markAgentLaunchesClosedByUser('wt-1', { kind: 'tab', tabId })
    const running = trackRunningAgentLaunchPane({
      worktreeId: 'wt-1',
      paneKey: `${tabId}:${leafId}`
    })
    expect(running.closedByUser()).toBe(false)
    markAgentLaunchesClosedByUser('wt-1', { kind: 'tab', tabId: 'tab-other' })
    markAgentLaunchesClosedByUser('wt-1', {
      kind: 'pane',
      tabId,
      leafId: '6fa459ea-ee8a-4ca4-894e-db77e160355e'
    })
    expect(running.closedByUser()).toBe(false)
    markAgentLaunchesClosedByUser('wt-1', { kind: 'pane', tabId, leafId })
    expect(running.closedByUser()).toBe(true)
  })

  it('attaches to a process that holds the pane, whatever the launch says', async () => {
    const running = trackRunningAgentLaunchPane(PANE)
    const verdict = resolveAgentLaunchPaneVerdict(PANE, () => true)
    running.finish({ kind: 'not-started', code: 'boom' })
    await expect(verdict).resolves.toEqual({ kind: 'proceed' })
  })
})
