import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentPromptSubmitDelayForAgent } from '../../shared/agent-prompt-injection'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-line-settle',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-line-settle',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

describe('agent prompt line-settle scheduling', () => {
  afterEach(() => vi.useRealTimers())
  it('waits for antigravity line-settle before the first Enter on a long prompt', async () => {
    vi.useFakeTimers()
    const prompt = `${'Filler line\n'.repeat(100)}AGY_LONG_OK`
    const submitDelayMs = resolveAgentPromptSubmitDelayForAgent(
      process.platform,
      prompt,
      'antigravity'
    )
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      () => undefined,
      'antigravity'
    )
    const submission = runtime.sendTerminalAgentPrompt(handle, prompt, { inputKind: 'driving' })
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(submitDelayMs - 1)
    expect(writes.filter((data) => data === '\r')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)

    await vi.runAllTimersAsync()
    await stalled
  })
})
