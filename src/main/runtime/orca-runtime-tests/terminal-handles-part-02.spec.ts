import { describe, expect, it, vi } from 'vitest'
import { movePaneFirst, registerBoundPty } from './bind-first-pane.test-fixture'
import {
  HEADLESS_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  createRuntime,
  createRuntimeWithSshLease
} from './orca-runtime-test-fixtures.spec'
import './runtime-test-module-registration.spec'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import '../orca-runtime'

describe('OrcaRuntimeService', () => {
  it('keeps a live CLI waiter pending when a re-keyed shared handle transfers to the live leaf', async () => {
    const runtime = createRuntime()
    const tabId = 'tab-1'
    // Re-keying a shared PTY handle must preserve its in-flight waiter.
    runtime.preAllocateHandleForPty('pty-agent')
    runtime.attachWindow(TEST_WINDOW_ID)
    await runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-old',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-old',
          paneRuntimeId: 1,
          ptyId: 'pty-agent'
        }
      ]
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    const sharedHandle = before.terminals[0].handle
    const abort = new AbortController()
    let settled: 'resolved' | 'rejected' | null = null
    const waiting = runtime
      .waitForTerminal(sharedHandle, {
        condition: 'exit',
        timeoutMs: 30_000,
        signal: abort.signal
      })
      .then(
        () => {
          settled = 'resolved'
        },
        () => {
          settled = 'rejected'
        }
      )

    await runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-new',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-new',
          paneRuntimeId: 2,
          ptyId: 'pty-agent'
        }
      ]
    })

    // Let any synchronous stale-handle rejection propagate.
    await new Promise<void>((resolve) => setImmediate(resolve))
    // The transferred shared handle must keep its CLI waiter pending.
    expect(settled).toBeNull()
    await expect(runtime.showTerminal(sharedHandle)).resolves.toMatchObject({
      ptyId: 'pty-agent'
    })

    abort.abort()
    await waiting
    expect(settled).toBe('rejected')
  })

  it('refuses a moved SSH pane addressed through the tab it left', async () => {
    // Old-tab coordinates must refuse the moved leaf; otherwise one PTY binds into two tabs.
    const leaseTabId = 'tab-stale-mirror'
    const currentTabId = 'tab-moved-to'
    const appPtyId = 'ssh:ssh-target@@pty-9'
    const runtime = createRuntimeWithSshLease(appPtyId, leaseTabId)
    const stalePaneKey = makePaneKey(leaseTabId, HEADLESS_LEAF_ID)
    registerBoundPty(runtime, appPtyId, TEST_WORKTREE_ID, 'ssh-target', {
      tabId: leaseTabId,
      leafId: HEADLESS_LEAF_ID
    })
    const staleHandle = runtime.resolveTerminalPane(stalePaneKey, TEST_WORKTREE_ID).handle
    movePaneFirst(runtime, leaseTabId, {
      worktreeId: TEST_WORKTREE_ID,
      tabId: currentTabId,
      leafId: HEADLESS_LEAF_ID,
      ptyId: appPtyId
    })
    runtime.registerPty(appPtyId, TEST_WORKTREE_ID, 'ssh-target', {
      tabId: currentTabId,
      leafId: HEADLESS_LEAF_ID
    })
    runtime.onPtyExit(appPtyId, -1, undefined, { hostExitConfirmed: true })
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    await expect(
      runtime.recoverTerminalPane(stalePaneKey, TEST_WORKTREE_ID, staleHandle)
    ).rejects.toThrow(/terminal_not_recoverable|terminal_not_found/)
    const leases = runtime as unknown as {
      getRecentExpiredSshLease: (worktreeId: string, tabId: string, leafId?: string) => unknown
    }
    expect(
      leases.getRecentExpiredSshLease(TEST_WORKTREE_ID, leaseTabId, HEADLESS_LEAF_ID)
    ).toBeNull()
    expect(
      leases.getRecentExpiredSshLease(TEST_WORKTREE_ID, currentTabId, HEADLESS_LEAF_ID)
    ).not.toBeNull()
    expect(createTerminal).not.toHaveBeenCalled()
  })
})
