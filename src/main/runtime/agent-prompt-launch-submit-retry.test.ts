import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentPromptSubmitDelayForAgent } from '../../shared/agent-prompt-injection'
import type { TuiAgent } from '../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import type { OrcaRuntimeService } from './orca-runtime'
import { dispatchPreambleSendOptions } from './orchestration/preamble'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/launch-submit-retry',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/launch-submit-retry',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

const PROMPT = 'Task: reply with OK'

async function sendDispatch(
  agent: TuiAgent,
  retrySubmitAfterLaunch: boolean,
  afterFirstEnter?: (runtime: OrcaRuntimeService) => void
) {
  let entered = false
  const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime((rt, data) => {
    if (data === '\r' && !entered) {
      entered = true
      afterFirstEnter?.(rt)
    }
  }, agent)
  const sent = runtime.sendTerminalAgentPrompt(handle, PROMPT, {
    ...dispatchPreambleSendOptions('request-1'),
    retrySubmitAfterLaunch
  })
  return { runtime, sent, enters: () => writes.filter((data) => data === '\r').length }
}

// Why: OpenCode 2 drops an Enter sent before its mode row is drawn, so a worker's first dispatch
// gets one more Enter; every other send keeps exactly one.
describe('retry Enter on a launched worker first dispatch', () => {
  afterEach(() => vi.useRealTimers())

  it.each(['opencode', 'opencode2'] as const)(
    '%s gets a second Enter after its row delay',
    async (agent) => {
      vi.useFakeTimers()
      const submitDelayMs = resolveAgentPromptSubmitDelayForAgent(process.platform, PROMPT, agent)
      const retryDelayMs = TUI_AGENT_CONFIG[agent].submitRetryDelayMs ?? 0
      const { sent, enters } = await sendDispatch(agent, true)

      await vi.advanceTimersByTimeAsync(submitDelayMs)
      expect(enters()).toBe(1)
      await vi.advanceTimersByTimeAsync(retryDelayMs - 1)
      expect(enters()).toBe(1)
      await vi.advanceTimersByTimeAsync(1)

      await expect(sent).resolves.toMatchObject({
        accepted: true,
        bytesWritten: expect.any(Number),
        prompt: { stages: ['input_accepted'] }
      })
      expect(enters()).toBe(2)
    }
  )

  it('keeps one Enter for dispatches that did not launch the agent', async () => {
    vi.useFakeTimers()
    const { sent, enters } = await sendDispatch('opencode', false)

    await vi.runAllTimersAsync()
    await sent
    expect(enters()).toBe(1)
  })

  it.each(['codex', 'claude', 'aider'] as const)(
    '%s keeps one Enter on a launched worker first dispatch',
    async (agent) => {
      vi.useFakeTimers()
      const { sent, enters } = await sendDispatch(agent, true)

      await vi.runAllTimersAsync()
      await sent
      expect(enters()).toBe(1)
    }
  )

  it('never answers a permission prompt drawn after the first Enter', async () => {
    vi.useFakeTimers()
    const { sent, enters } = await sendDispatch('opencode', true, (runtime) => {
      runtime.onPtyData(
        'pty-prompt',
        '\x1b]9999;{"state":"waiting","agentType":"opencode"}\x07',
        Date.now()
      )
    })

    await vi.runAllTimersAsync()
    await expect(sent).resolves.toMatchObject({ accepted: true })
    expect(enters()).toBe(1)
  })

  it('leaves the first Enter standing when the pane exits before the retry', async () => {
    vi.useFakeTimers()
    const submitDelayMs = resolveAgentPromptSubmitDelayForAgent(
      process.platform,
      PROMPT,
      'opencode'
    )
    const { runtime, sent, enters } = await sendDispatch('opencode', true)

    await vi.advanceTimersByTimeAsync(submitDelayMs)
    expect(enters()).toBe(1)
    await runtime.onPtyExit('pty-prompt', 0)
    await vi.runAllTimersAsync()

    await expect(sent).resolves.toMatchObject({ accepted: true })
    expect(enters()).toBe(1)
  })
})
