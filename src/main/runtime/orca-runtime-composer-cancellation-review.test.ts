import { expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-verification',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-verification',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

it.each([false, true])(
  'honors cancellation during composer readiness (already aborted: %s)',
  async (alreadyAborted) => {
    vi.useFakeTimers()
    try {
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        () => undefined,
        'codex'
      )
      const controller = new AbortController()
      if (alreadyAborted) {
        controller.abort()
      }
      let failure: unknown
      const pending = runtime
        .sendTerminalAgentPrompt(handle, 'cancel this prompt', { signal: controller.signal })
        .catch((error) => {
          failure = error
        })
      await vi.advanceTimersByTimeAsync(10)
      if (!alreadyAborted) {
        controller.abort()
      }
      await vi.advanceTimersByTimeAsync(10)
      expect.soft(failure).toBeDefined()
      expect.soft(writes).toEqual([])
      await vi.advanceTimersByTimeAsync(20_000)
      await pending
      expect.soft(failure).toMatchObject({ message: 'request_aborted' })
    } finally {
      vi.useRealTimers()
    }
  }
)
