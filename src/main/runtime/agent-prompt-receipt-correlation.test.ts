import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-correlation',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-correlation',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

describe('agent prompt receipt correlation', () => {
  afterEach(() => vi.useRealTimers())

  it('assigns historical lifecycle edges to queued receipts in FIFO order', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      () => undefined,
      'codex'
    )
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())

    const firstPromise = runtime.sendTerminalAgentPrompt(handle, 'first prompt', {
      acceptQueued: true,
      requestId: 'historical-first',
      observationTimeoutMs: 0
    })
    await vi.runAllTimersAsync()
    const first = await firstPromise
    const secondPromise = runtime.sendTerminalAgentPrompt(handle, 'second prompt', {
      acceptQueued: true,
      requestId: 'historical-second',
      observationTimeoutMs: 0
    })
    await vi.runAllTimersAsync()
    const second = await secondPromise

    runtime.onPtyData(
      'pty-prompt',
      '\x1b]0;Codex idle\x07\x1b]0;Codex working\x07' +
        '\x1b]0;Codex idle\x07\x1b]0;Codex working\x07',
      Date.now()
    )

    const writesAfterSubmission = writes.length
    await expect(
      runtime.observeTerminalAgentPrompt(handle, second.prompt!, 0)
    ).resolves.toMatchObject({ stages: ['input_accepted', 'turn_started'] })
    await expect(
      runtime.observeTerminalAgentPrompt(handle, first.prompt!, 0)
    ).resolves.toMatchObject({ stages: ['input_accepted', 'turn_started'] })
    // Observing a queued receipt must never write to the PTY again.
    expect(writes).toHaveLength(writesAfterSubmission)
  })
})
