import { afterEach, describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  resetAgentLaunchPanesForTests,
  trackRunningAgentLaunchPane
} from '../agent-launch/agent-launch-pane-attachment'
import {
  LEAF_ID,
  PTY_ID,
  SIBLING_LEAF_ID,
  TAB_ID,
  WORKTREE_ID,
  createHarness
} from './__fixtures__/orca-runtime-terminal-close-continuity-fixtures'

afterEach(() => {
  resetAgentLaunchPanesForTests()
})

function launchIn(leafId: string) {
  return trackRunningAgentLaunchPane({
    worktreeId: WORKTREE_ID,
    paneKey: makePaneKey(TAB_ID, leafId)
  })
}

describe("a pane close main starts (a phone's, the CLI's)", () => {
  it('stops a launch still running in that pane, and only that one', async () => {
    const harness = createHarness({ publishMobileSurface: true })
    harness.syncSplitFixtureGraph()
    const closed = launchIn(LEAF_ID)
    const sibling = launchIn(SIBLING_LEAF_ID)
    const terminal = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals.find(
      (candidate) => candidate.ptyId === PTY_ID
    )
    if (!terminal) {
      throw new Error('fixture pane has no terminal handle')
    }

    await harness.runtime.closeTerminal(terminal.handle)

    expect(harness.closeTerminalPane).toHaveBeenCalledWith(TAB_ID, LEAF_ID)
    expect(closed.closedByUser()).toBe(true)
    expect(sibling.closedByUser()).toBe(false)
  })
})
