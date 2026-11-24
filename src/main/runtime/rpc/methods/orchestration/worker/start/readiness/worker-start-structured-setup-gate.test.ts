import { expect, it, vi } from 'vitest'
import { setRuntimeDesktopSurface } from '../../../../../../construction/runtime-desktop-surface'
import {
  setupLayoutOwnerRuntime,
  WORKTREE_ID
} from '../../../../../../terminal/layout/orca-runtime-layout-owner-start-fixture'
import type { WorkerEffect, WorkerSetupReceipt } from '../placement/worker-placement-topology'
import { awaitStructuredWorkerSetupGate } from './worker-start-structured-setup-gate'

it('waits for setup on a terminal the window adopted before the wait began', async () => {
  const { runtime } = setupLayoutOwnerRuntime()
  setRuntimeDesktopSurface({
    showNotification: () => false,
    hasWindow: () => true,
    hasLiveRenderer: () => true,
    sendToWindow: () => true,
    requestRenderer: () => Promise.reject(new Error('unexpected renderer request'))
  })
  const tabId = '11111111-1111-4111-8111-111111111111'
  const leafId = '22222222-2222-4222-8222-222222222222'
  const ptyId = 'pty-setup'
  const handle = 'term_setup'
  // oxlint-disable-next-line typescript/no-explicit-any, typescript/consistent-type-assertions -- SAFETY: drives the create path's protected handle registration.
  const internals = runtime as any
  runtime.attachWindow(1)
  internals.registerPreAllocatedHandleForPty(ptyId, handle)
  runtime.registerPty(ptyId, WORKTREE_ID, null, { tabId, leafId, terminalHandle: handle })
  internals.issuePtyHandle(internals.ptysById.get(ptyId))
  try {
    await runtime.syncWindowGraph(1, {
      tabs: [
        { tabId, worktreeId: WORKTREE_ID, title: 'Setup', activeLeafId: leafId, layout: null }
      ],
      leaves: [{ tabId, worktreeId: WORKTREE_ID, leafId, paneRuntimeId: 1, ptyId }]
    })
    const host = runtime.provisioningHost()
    expect(host.getPtyId(handle)).toBe(ptyId)
    host.recordSetupCompletionToken(ptyId, 'token-1')

    vi.useFakeTimers()
    const effects: WorkerEffect[] = [{ kind: 'setup', terminalId: handle }]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate reads only policy and state.
    const setup = { startupPolicy: 'wait-for-setup', state: 'running' } as WorkerSetupReceipt
    let settled = false
    const gate = awaitStructuredWorkerSetupGate({ runtime, setup, effects, timeoutMs: 5_000 }).then(
      (result) => {
        settled = true
        return result
      }
    )
    // Unfixed, the gate settles at once with no verdict; fixed, it waits out the budget's last tick.
    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).toBe(false)

    runtime.onPtyData(ptyId, '\n__ORCA_SETUP_COMPLETE__:token-1:0\n', 1)
    expect(await gate).toEqual({ satisfied: true, status: 'exited' })
    expect(effects.some((effect) => effect.action === 'wait_unevaluated')).toBe(false)
  } finally {
    vi.useRealTimers()
    await runtime.onPtyExit(ptyId, 0)
    setRuntimeDesktopSurface(null)
  }
})
