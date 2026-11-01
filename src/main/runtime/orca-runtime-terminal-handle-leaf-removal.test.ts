import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { DISCONNECTED_PTY_RECORD_MAX } from './orca-runtime-postlude'
import {
  createHarness,
  LEAF_ID,
  PTY_ID,
  TAB_ID,
  WORKTREE_ID,
  type CloseContinuityHarness
} from './__fixtures__/orca-runtime-terminal-close-continuity-fixtures'

// A paired client's exit wait can reach the host after the close removed the pane it resolved,
// and a terminal list can run in between. The pane's handle keeps answering that wait; the
// terminal itself is listed and controlled through its own handle, as main does for unshown terminals.
function paneHandle(harness: CloseContinuityHarness): string {
  return harness.runtime.resolveTerminalPane(makePaneKey(TAB_ID, LEAF_ID), WORKTREE_ID).handle
}
function waitForExit(harness: CloseContinuityHarness, handle: string) {
  return harness.runtime.waitForTerminal(handle, { condition: 'exit', timeoutMs: 1_000 })
}
async function listedHandle(harness: CloseContinuityHarness): Promise<string> {
  const { terminals } = await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)
  const listed = terminals.find((terminal) => terminal.ptyId === PTY_ID)
  expect(listed).toBeDefined()
  return listed!.handle
}
const EXITED = { satisfied: true, status: 'exited', exitCode: 0 }

describe('a pane-issued handle names its PTY incarnation, not the pane', () => {
  it('answers an exit wait registered after its leaf left while the PTY still ran', async () => {
    const harness = createHarness({ registerPtyBacked: true })
    const handle = paneHandle(harness)
    harness.syncEmptyGraph()
    const waiting = waitForExit(harness, handle)
    harness.runtime.onPtyExit(PTY_ID, 0)
    await expect(waiting).resolves.toMatchObject(EXITED)
  })

  it('lists a live unshown terminal under its own working handle; after exit only the pane wait answers', async () => {
    const harness = createHarness({ registerPtyBacked: true })
    const handle = paneHandle(harness)
    harness.syncEmptyGraph()
    const listed = await listedHandle(harness)
    expect(listed).not.toBe(handle)
    await expect(harness.runtime.readTerminal(listed)).resolves.toMatchObject({
      status: 'running'
    })
    await expect(harness.runtime.showTerminal(listed)).resolves.toBeDefined()
    await expect(
      harness.runtime.sendTerminal(listed, { text: 'ls' }, { inputKind: 'driving' })
    ).resolves.toBeDefined()
    // The process exits before the delayed wait arrives, after another graph sync.
    harness.removeVictimFromInventory()
    harness.runtime.onPtyExit(PTY_ID, 0)
    harness.syncEmptyGraph()
    await expect(waitForExit(harness, handle)).resolves.toMatchObject(EXITED)
    await expect(harness.runtime.readTerminal(listed)).resolves.toMatchObject({ status: 'exited' })
    await expect(harness.runtime.showTerminal(listed)).resolves.toBeDefined()
    for (const exited of [handle, listed]) {
      await expect(
        harness.runtime.sendTerminal(exited, { text: 'ls' }, { inputKind: 'driving' })
      ).rejects.toThrow()
      await expect(harness.runtime.focusTerminal(exited)).rejects.toThrow()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the runtime's own mail-target lookup.
    const mail = harness.runtime as unknown as {
      getOrchestrationMailboxTerminalForHandle(handle: string): unknown
    }
    expect(mail.getOrchestrationMailboxTerminalForHandle(handle)).toBeNull()
    expect(mail.getOrchestrationMailboxTerminalForHandle(listed)).toBeNull()
  })

  it('answers a late exit wait when the exit came before the pane left', async () => {
    const harness = createHarness({ registerPtyBacked: true })
    const handle = paneHandle(harness)
    harness.removeVictimFromInventory()
    harness.runtime.onPtyExit(PTY_ID, 0)
    harness.syncEmptyGraph()
    await expect(waitForExit(harness, handle)).resolves.toMatchObject(EXITED)
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

  it('refuses the old handle once the exited-terminal archive prunes its record', async () => {
    const harness = createHarness({ registerPtyBacked: true })
    const handle = paneHandle(harness)
    harness.runtime.onPtyExit(PTY_ID, 0)
    harness.syncEmptyGraph()
    for (let index = 0; index < DISCONNECTED_PTY_RECORD_MAX; index += 1) {
      harness.runtime.registerPty(`pty-archived-${index}`, WORKTREE_ID)
      harness.runtime.onPtyExit(`pty-archived-${index}`, 0)
    }
    await expect(waitForExit(harness, handle)).rejects.toThrow('terminal_handle_stale')
  })

  it('keeps nothing for an unknown incarnation, so a returning pane gets a new handle', async () => {
    const harness = createHarness()
    const handle = paneHandle(harness)
    harness.syncEmptyGraph()
    await expect(waitForExit(harness, handle)).rejects.toThrow('terminal_handle_stale')
    harness.syncFixtureGraph()
    expect(paneHandle(harness)).not.toBe(handle)
  })
})
