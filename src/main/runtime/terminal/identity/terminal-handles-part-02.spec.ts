import { describe, expect, it } from 'vitest'
import '../layout/bind-first-pane.test-fixture'
import {
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  createRuntime
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import '../../construction/test-context/runtime-test-module-registration.spec'
import '../../../../shared/workspace-layout/stable-pane-id'
import '../../orca-runtime'

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
})
