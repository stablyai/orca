import { describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  createRuntime,
  createRuntimeWithSshLease
} from '../orca-runtime-test-fixtures.spec'
import { makePaneKey } from '../orca-runtime-test-mocks.spec'

describe('OrcaRuntimeService', () => {
  it('invalidates a re-keyed leaf-unique handle so in-flight waiters fail fast', async () => {
    const runtime = createRuntime()
    const tabId = 'tab-1'
    // No preAllocateHandleForPty: a plain terminal's handle is leaf-unique, so a re-key leaves it with no next owner and it goes stale immediately.
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Shell',
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
          ptyId: 'pty-plain'
        }
      ]
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(before.terminals).toHaveLength(1)
    const staleHandle = before.terminals[0].handle
    const waiting = runtime.waitForTerminal(staleHandle, { condition: 'exit', timeoutMs: 30_000 })

    // Re-key WITHOUT a renderer reload (e.g. a pane moved across tabs) while the same PTY stays live under a new leaf.
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Shell',
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
          ptyId: 'pty-plain'
        }
      ]
    })

    // The waiter must fail fast, not hang until timeout on a dead leaf.
    await expect(waiting).rejects.toThrow('terminal_handle_stale')
    const after = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(after.terminals).toHaveLength(1)
    expect(after.terminals[0].handle).not.toBe(staleHandle)
  })

  it('keeps a live CLI waiter pending when a re-keyed shared handle transfers to the live leaf', async () => {
    const runtime = createRuntime()
    const tabId = 'tab-1'
    // Unlike the leaf-unique case, a shared ptyId-keyed handle re-keyed to a live leaf must transfer WITHOUT rejecting the in-flight CLI waiter.
    runtime.preAllocateHandleForPty('pty-agent')
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
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

    // Re-key WITHOUT a renderer reload while the same agent PTY stays live under a new leaf.
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
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
    // The shared handle belongs to leaf-new now, so the CLI's live waiter must stay pending (a blanket invalidateLeafHandle would reject it as stale).
    expect(settled).toBeNull()
    // The same handle still resolves to the live PTY under the new leaf.
    await expect(runtime.showTerminal(sharedHandle)).resolves.toMatchObject({
      ptyId: 'pty-agent'
    })

    // Abort only for teardown; the assertion above already proved it was pending.
    abort.abort()
    await waiting
    expect(settled).toBe('rejected')
  })
  it('recovers a moved SSH pane through the tab it now sits in, not the one its lease froze', async () => {
    // `detachTerminalPaneToTab` moves a live pane and the lease keeps naming the tab it LEFT.
    // Matching on that frozen tabId refused the pane's real coordinates outright, so a moved pane
    // could only ever be "recovered" through coordinates it had already abandoned.
    const leaseTabId = 'tab-before-move'
    const currentTabId = 'tab-after-move'
    const appPtyId = 'ssh:ssh-target@@pty-8'
    const runtime = createRuntimeWithSshLease(appPtyId, leaseTabId)
    const paneKey = makePaneKey(currentTabId, HEADLESS_LEAF_ID)
    runtime.registerPty(appPtyId, TEST_WORKTREE_ID, 'ssh-target', {
      tabId: currentTabId,
      leafId: HEADLESS_LEAF_ID
    })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit(appPtyId, -1, undefined, { hostExitConfirmed: true })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term-replacement',
      tabId: currentTabId,
      paneKey,
      ptyId: 'pty-replacement',
      worktreeId: TEST_WORKTREE_ID,
      title: null,
      surface: 'background'
    })

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)
    ).resolves.toMatchObject({ handle: 'term-replacement' })
    expect(createTerminal).toHaveBeenCalledWith(`id:${TEST_WORKTREE_ID}`, {
      tabId: currentTabId,
      leafId: HEADLESS_LEAF_ID,
      focus: false
    })
  })

  it('refuses a moved SSH pane addressed through the tab it left', async () => {
    // The other half: a viewer on a stale mirror asks under the OLD tab, whose layout no longer
    // holds this leaf. Accepting it binds one leaf in two tabs and leaves the PTY under the current
    // tab orphaned with its agent still running. The handle CAS happens to refuse first here, so
    // the lease resolver is asserted directly - it is the independent second refusal.
    const leaseTabId = 'tab-stale-mirror'
    const currentTabId = 'tab-moved-to'
    const appPtyId = 'ssh:ssh-target@@pty-9'
    const runtime = createRuntimeWithSshLease(appPtyId, leaseTabId)
    const stalePaneKey = makePaneKey(leaseTabId, HEADLESS_LEAF_ID)
    runtime.registerPty(appPtyId, TEST_WORKTREE_ID, 'ssh-target', {
      tabId: leaseTabId,
      leafId: HEADLESS_LEAF_ID
    })
    const staleHandle = runtime.resolveTerminalPane(stalePaneKey, TEST_WORKTREE_ID).handle
    // The move: same leaf, same PTY, new tab.
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
