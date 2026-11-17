import { describe, expect, it } from 'vitest'
import '../../../../shared/workspace-layout/layout-owner-switch'
import '../../../../shared/workspace-layout/stable-pane-id'

import '../../../agent-launch/agent-launch-pane-attachment'
import {
  PTY_ID,
  SIBLING_INCARNATION_ID,
  WORKTREE_ID
} from '../../__fixtures__/orca-runtime-terminal-close-continuity-state-fixture'
import {
  createHarness,
  createStaleTabCloseHarness
} from '../../__fixtures__/orca-runtime-terminal-close-continuity-fixtures'
import '../../__fixtures__/main-layout-close-fixture'

/** Last-pane close retires the tab: legacy renderer acknowledges, main-owned layout persists before stopping. */

describe('terminal close and handle incarnation continuity', () => {
  it('does not let a colliding PTY id close a different persisted incarnation', async () => {
    const harness = await createStaleTabCloseHarness({ headless: true })
    harness.replacePersistedIncarnation(SIBLING_INCARNATION_ID)
    const { terminal } = harness

    await expect(harness.runtime.closeTerminalTab(terminal.handle)).rejects.toThrow(
      'terminal_handle_stale'
    )

    expect(harness.kill).not.toHaveBeenCalled()
    expect(harness.closeTerminalTab).not.toHaveBeenCalled()
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  })

  it('keeps a handle through an intermediate empty reload graph', async () => {
    const harness = await createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;\u280b Working on task\x07output\n', 100)
    const waiting = harness.runtime.waitForTerminal(before.handle, {
      condition: 'tui-idle',
      timeoutMs: 1_000
    })

    harness.runtime.markRendererReloading(1)
    await harness.syncEmptyGraph()
    await harness.syncFixtureGraph()
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;\u2733 Task complete\x07done\n', 200)

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).toBe(before.handle)
    await expect(waiting).resolves.toMatchObject({
      handle: before.handle,
      condition: 'tui-idle',
      satisfied: true
    })
    await expect(harness.runtime.readTerminal(before.handle)).resolves.toMatchObject({
      handle: before.handle,
      status: 'running'
    })
  })

  it('stales the old handle when the same PTY id names a new incarnation', async () => {
    const harness = await createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    harness.runtime.markRendererReloading(1)
    harness.replaceIncarnation('33333333-3333-4333-8333-333333333333')
    harness.replacePersistedIncarnation('33333333-3333-4333-8333-333333333333')
    await harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).not.toBe(before.handle)
    expect(after.incarnationId).toBe('33333333-3333-4333-8333-333333333333')
    await expect(harness.runtime.readTerminal(before.handle)).rejects.toThrow(
      'terminal_handle_stale'
    )
  })
})

/** CLI/headless path: PTY-backed tab without a paired-viewer surface. */
