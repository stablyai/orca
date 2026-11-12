import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { TEST_WORKTREE_ID, syncSinglePty, store } from './orca-runtime-test-fixtures.spec'
import { createSideEffectRuntime } from './orca-runtime-test-scenario-builders.spec'

describe('terminal side-effect fact channel', () => {
  it('emits command-code-working facts only after the banner arms the scrape', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '❯ Fix the spinner\r\nThinking...', 100)
    expect(batches.flatMap((batch) => batch.facts)).toEqual([])

    runtime.onPtyData('pty-1', '# Command Code v0.27.3\r\n', 101)
    runtime.onPtyData('pty-1', '❯ Fix the spinner\r\n\x1b[35m✻ Thinking...\x1b[0m', 102)

    expect(batches.at(-1)).toMatchObject({
      ptyId: 'pty-1',
      worktreeId: TEST_WORKTREE_ID,
      tabId: 'tab-1'
    })
    expect(batches.at(-1)?.facts).toEqual([
      { kind: 'command-code-working', prompt: 'Fix the spinner' }
    ])
  })

  it('emits a command-code-done fact when the idle composer returns', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '# Command Code v0.27.3\r\n', 100)
    runtime.onPtyData('pty-1', '❯ say hi\r\n✻ Thinking...', 101)
    runtime.onPtyData(
      'pty-1',
      '\r\n✻ Thought for 1 second\r\n:: Hi!\r\n❯ Ask your question...',
      102
    )

    expect(batches.at(-1)?.facts).toEqual([{ kind: 'command-code-done', prompt: 'say hi' }])
  })
})

it.each([false, true])(
  'does not infer completion during stop; stopped=%s settles the pending producer',
  async (stopped) => {
    vi.useFakeTimers()
    let row: AgentStatusIpcPayload | undefined
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshotForPane: () => (row ? [row] : []),
      onTerminalAgentStatus: (event) => {
        row = {
          ...event.payload,
          paneKey: event.paneKey,
          connectionId: null,
          stateStartedAt: Date.now(),
          receivedAt: Date.now()
        }
      }
    })
    try {
      syncSinglePty(runtime)
      runtime.onPtyData('pty-1', '# Command Code v0.27.3\r\n', 100)
      runtime.onPtyData('pty-1', '❯ say hi\r\n✻ Thinking...', 101)
      expect(row).toMatchObject({ state: 'working', agentType: 'command-code', prompt: 'say hi' })
      const settle = runtime.intentionalPtyStops.mark('pty-1', 'reversible', null)
      runtime.onPtyData(
        'pty-1',
        '\r\n✻ Thought for 1 second\r\n:: Hi!\r\n❯ Ask your question...',
        102
      )
      await vi.advanceTimersByTimeAsync(2000)
      expect(row?.state).toBe('working')
      settle(stopped)
      await vi.advanceTimersByTimeAsync(2000)
      expect(row?.state).toBe(stopped ? 'working' : 'done')
    } finally {
      await runtime.onPtyExit('pty-1', 0)
      vi.useRealTimers()
    }
  }
)
