import { describe, expect, it } from 'vitest'
import { TEST_WINDOW_ID, TEST_WORKTREE_ID, createRuntime } from '../orca-runtime-test-fixtures.spec'
import '../orca-runtime-test-mocks.spec'

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
})
