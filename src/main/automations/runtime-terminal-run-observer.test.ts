import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../runtime/orca-runtime-tests/agent-transcript-pane-test-harness'
import { createRuntimeAutomationRunTerminalObserver } from './runtime-terminal-run-observer'

describe('createRuntimeAutomationRunTerminalObserver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('propagates recorded end from the real runtime initial probe without a startup wait', async () => {
    vi.useRealTimers()
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'shell',
      foregroundProcess: 'bash',
      data: ''
    })
    runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 137, 'inc-1', { providerExitObserved: true })
    vi.useFakeTimers()
    const observer = createRuntimeAutomationRunTerminalObserver(runtime)
    await expect(
      observer.observeCompletion(handle, { signal: new AbortController().signal })
    ).rejects.toThrow('terminal_exited')
    expect(runtime['terminalWaiters'].forPty(TRANSCRIPT_PANE_PTY_ID)).toHaveLength(0)
  })
})
