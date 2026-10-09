import { describe, expect, it } from 'vitest'
import {
  PTY_ID,
  TAB_ID,
  WORKTREE_ID,
  createHarness,
  type CloseContinuityHarness
} from './__fixtures__/orca-runtime-terminal-close-continuity-fixtures'

async function closeByPty(harness: CloseContinuityHarness): Promise<unknown> {
  const terminal = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals.find(
    (candidate) => candidate.ptyId === PTY_ID
  )
  if (!terminal) {
    throw new Error('fixture pane has no terminal handle')
  }
  return harness.runtime.closeTerminal(terminal.handle)
}

/** A PTY-backed tab with no paired-viewer surface: the path orcad serves to the CLI. */
function headlessPtyTab(): CloseContinuityHarness {
  const harness = createHarness({ registerPtyBacked: true })
  harness.syncFixtureTabWithoutLeaf()
  harness.setVerifiedStopResult(true)
  return harness
}

describe('closing a terminal by PTY on a host without a renderer tab', () => {
  it('stops the PTY without asking a missing renderer to close the tab', async () => {
    const harness = headlessPtyTab()
    harness.syncEmptyGraph()

    await expect(closeByPty(harness)).resolves.toMatchObject({ tabId: TAB_ID })

    expect(harness.closeTerminalTab).not.toHaveBeenCalled()
    expect(harness.stopAndWait).toHaveBeenCalledWith(PTY_ID, expect.anything())
  })

  it('does not fail the close when the advisory renderer notification throws', async () => {
    const harness = headlessPtyTab()
    harness.syncEmptyGraph()
    harness.closeTerminal.mockImplementation(() => {
      throw new Error('renderer gone')
    })

    await expect(closeByPty(harness)).resolves.toMatchObject({ tabId: TAB_ID })
  })
})
