import { describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  createRuntimeWithSshLease
} from './orca-runtime-test-fixtures.spec'
import { makePaneKey } from './orca-runtime-test-mocks.spec'

// What `terminal.recoverPane` may and may not treat as authority to spawn a replacement shell over
// a remote pane. Lives in a `.test.ts` rather than beside the other recoverPane cases in
// orca-runtime-tests/*.spec.ts because config/vitest.config.ts — the config CI runs — includes only
// `*.test.ts`, so a ratchet placed there would never execute.

describe('terminal.recoverPane liveness gate', () => {
  it('recreates a shell for an SSH pane the relay disowned, the only evidence this gate ever gets', async () => {
    // The whole production route into recoverPane, end to end. A reachable relay answered for this
    // exact id and did not name it — via pty.attach in handlePtyReattachFailure, or the identical
    // answer in the inventory listing below — and that answer is a union: pty.attach throws
    // not-found for an unknown id with no liveness check, and pty.listProcesses returns only
    // the CURRENT session map, which after a relay restart omits every previously minted id. So no
    // `exited` certificate exists to demand here, and no writer of one co-occurs with a
    // reattachable `expired` lease: a host-delivered exit frame tombstones the lease `terminated`
    // instead. Requiring `exited` therefore closes this gate permanently
    // (docs/reference/ssh-execution-boundary.md).
    const tabId = 'tab-relay-disowned'
    const ptyId = 'ssh:ssh-target@@pty-10'
    const runtime = createRuntimeWithSshLease(ptyId, tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      hasPty: (id: string) => id !== ptyId,
      // A sibling on the same relay still reports, so the host itself answered this listing.
      listProcesses: async () => [
        { id: 'ssh:ssh-target@@pty-sibling', worktreeId: TEST_WORKTREE_ID }
      ],
      getForegroundProcess: async () => null
    } as never)
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, 'ssh-target', { tabId, leafId: HEADLESS_LEAF_ID })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    // The sweep is what disconnects the pane: handlePtyReattachFailure tells only the renderer and
    // the reattach spawn path only expires the lease, so nothing else reaches the runtime record.
    await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(runtime.getPtyLivenessVerdict(ptyId)).toBeNull()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term-replacement',
      tabId,
      paneKey,
      ptyId: 'pty-replacement',
      worktreeId: TEST_WORKTREE_ID,
      title: null,
      surface: 'background'
    })

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)
    ).resolves.toMatchObject({ handle: 'term-replacement' })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('refuses to recreate a shell for an expired lease the host proved is still live', async () => {
    // The production writer: reattach SUCCEEDED and then persistPtyBinding refused the surface, so
    // ssh-relay-session records `live` before writing `expired`. `expired` alone would read as
    // "reattach gave up", and spawning here would put a second agent on a transcript the host just
    // proved is still running.
    const tabId = 'tab-proved-live'
    const ptyId = 'ssh:ssh-target@@pty-11'
    const runtime = createRuntimeWithSshLease(ptyId, tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, 'ssh-target', { tabId, leafId: HEADLESS_LEAF_ID })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit(ptyId, -1)
    runtime.markPtyLivenessLive(ptyId)
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    await expect(runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)).rejects.toThrow(
      'terminal_not_recoverable'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('refuses to recreate a shell for an expired lease whose PTY liveness is unverifiable', async () => {
    // The relay delivers an exit frame carrying code -1 for an SSH pane with no host confirmation
    // (`preservesAbnormalSshSurface`) while the lease is already 'expired'. Neither observed the
    // process, and spawning here rebinds the pane away from a shell still running on the host.
    const tabId = 'tab-unverifiable-gate'
    const ptyId = 'ssh:ssh-target@@pty-12'
    const runtime = createRuntimeWithSshLease(ptyId, tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, 'ssh-target', { tabId, leafId: HEADLESS_LEAF_ID })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit(ptyId, -1)
    expect(runtime.getPtyLivenessVerdict(ptyId)?.status).toBe('unverifiable')
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    await expect(runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)).rejects.toThrow(
      'terminal_not_recoverable'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('still recreates a shell for an SSH pane whose host attested the exit', async () => {
    // The negative control on the other side: a host-delivered exit frame is a real certificate, so
    // the pane a paired client asks about must still get a replacement.
    const tabId = 'tab-attested-gate'
    const ptyId = 'ssh:ssh-target@@pty-13'
    const runtime = createRuntimeWithSshLease(ptyId, tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, 'ssh-target', { tabId, leafId: HEADLESS_LEAF_ID })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit(ptyId, -1, undefined, { hostExitConfirmed: true })
    expect(runtime.getPtyLivenessVerdict(ptyId)?.status).toBe('exited')
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term-replacement',
      tabId,
      paneKey,
      ptyId: 'pty-replacement',
      worktreeId: TEST_WORKTREE_ID,
      title: null,
      surface: 'background'
    })

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)
    ).resolves.toMatchObject({ handle: 'term-replacement' })
    expect(createTerminal).toHaveBeenCalledOnce()
  })
})
