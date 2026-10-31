import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  createHarness,
  LEAF_ID,
  PTY_ID,
  TAB_ID,
  WORKTREE_ID,
  type CloseContinuityHarness
} from './__fixtures__/orca-runtime-terminal-close-continuity-fixtures'

// A paired client's exit wait can reach the host after the close removed the pane it resolved.
function paneHandle(harness: CloseContinuityHarness): string {
  return harness.runtime.resolveTerminalPane(makePaneKey(TAB_ID, LEAF_ID), WORKTREE_ID).handle
}
function waitForExit(harness: CloseContinuityHarness, handle: string) {
  return harness.runtime.waitForTerminal(handle, { condition: 'exit', timeoutMs: 1_000 })
}

describe('a pane-issued handle names its PTY incarnation, not the pane', () => {
  it('answers an exit wait registered after its leaf left while the PTY still ran', async () => {
    const harness = createHarness({ registerPtyBacked: true })
    const handle = paneHandle(harness)
    harness.syncEmptyGraph()
    const waiting = waitForExit(harness, handle)
    harness.runtime.onPtyExit(PTY_ID, 0)
    await expect(waiting).resolves.toMatchObject({ satisfied: true, status: 'exited', exitCode: 0 })
  })

  it('answers a late exit wait from the retained exited record', async () => {
    const harness = createHarness({ registerPtyBacked: true })
    const handle = paneHandle(harness)
    harness.runtime.onPtyExit(PTY_ID, 0)
    harness.syncEmptyGraph()
    await expect(waitForExit(harness, handle)).resolves.toMatchObject({
      satisfied: true,
      status: 'exited',
      exitCode: 0
    })
    // Naming the process grants no pane: nothing focuses or mails into the closed terminal.
    await expect(harness.runtime.focusTerminal(handle)).rejects.toThrow()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the runtime's own mail-target lookup.
    const mail = harness.runtime as unknown as {
      getOrchestrationMailboxTerminalForHandle(handle: string): unknown
    }
    expect(mail.getOrchestrationMailboxTerminalForHandle(handle)).toBeNull()
  })

  it('refuses the old handle once the PTY id names a new incarnation', async () => {
    const harness = createHarness({ registerPtyBacked: true })
    const handle = paneHandle(harness)
    harness.syncEmptyGraph()
    harness.runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: '44444444-4444-4444-8444-444444444444'
    })
    await expect(waitForExit(harness, handle)).rejects.toThrow('terminal_handle_stale')
  })

  it('refuses the old handle once its exited record is pruned', async () => {
    const harness = createHarness({ registerPtyBacked: true })
    const handle = paneHandle(harness)
    harness.runtime.onPtyExit(PTY_ID, 0)
    harness.syncEmptyGraph()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: drives the archive cap's own prune step for one record.
    ;(
      harness.runtime as unknown as { dropDisconnectedPtyRecord(id: string): void }
    ).dropDisconnectedPtyRecord(PTY_ID)
    await expect(waitForExit(harness, handle)).rejects.toThrow('terminal_handle_stale')
  })
})
