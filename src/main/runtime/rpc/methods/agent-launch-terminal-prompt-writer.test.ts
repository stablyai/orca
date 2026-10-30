/** A cancelled launch prompt against the real writer: text whose Enter was written is delivered,
 *  whichever later check the abort then trips. */

import { describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { createAgentPromptSubmissionRuntime } from '../../agent-prompt-submission-runtime-test-fixture'
import { deliverTerminalAgentLaunchPrompt } from './agent-launch-terminal-prompt'

vi.mock('../../../git/worktree', () => ({
  listWorktrees: vi
    .fn()
    .mockResolvedValue([
      { path: '/tmp/worktree-a', head: 'abc', branch: 'b', isBare: false, isMainWorktree: false }
    ]),
  listWorktreesStrict: vi
    .fn()
    .mockResolvedValue([
      { path: '/tmp/worktree-a', head: 'abc', branch: 'b', isBare: false, isMainWorktree: false }
    ])
}))

async function deliverAbortingAt(agent: TuiAgent, abortWhen: (data: string) => boolean) {
  const controller = new AbortController()
  const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime((_runtime, data) => {
    if (abortWhen(data)) {
      controller.abort()
    }
  }, agent)
  vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
    handle,
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const delivered = await deliverTerminalAgentLaunchPrompt({
    runtime,
    handle,
    agent,
    freshLaunch: false,
    text: 'fix the flaky test',
    signal: controller.signal
  })
  return { delivered, writes }
}

describe('cancelling a launch prompt in the real writer', () => {
  it("reports OMP's combined paste and Enter as delivered when the abort follows it", async () => {
    const { delivered, writes } = await deliverAbortingAt('omp', (data) => data.endsWith('\r'))

    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('fix the flaky test')
    expect(writes[0]!.endsWith('\r')).toBe(true)
    expect(delivered).toBe(true)
  })

  it('reports a separate Enter as delivered when the abort follows it', async () => {
    const { delivered, writes } = await deliverAbortingAt('claude', (data) => data === '\r')

    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    expect(delivered).toBe(true)
  })

  it('reports text cancelled between paste and Enter as not delivered', async () => {
    const { delivered, writes } = await deliverAbortingAt('claude', (data) =>
      data.includes('fix the flaky test')
    )

    expect(writes.filter((data) => data === '\r')).toHaveLength(0)
    expect(delivered).toBe(false)
  })
})

it('forwards accepted Enter once without a signal and bypasses busy readiness only on reuse', async () => {
  const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'omp')
  const wait = vi.spyOn(runtime, 'waitForTerminal').mockRejectedValue(new Error('busy'))
  const submitted = vi.fn()
  const delivered = await deliverTerminalAgentLaunchPrompt({
    runtime,
    handle,
    agent: 'omp',
    freshLaunch: false,
    allowBusy: true,
    text: 'unique followup',
    onSubmitWritten: submitted
  })
  expect(delivered).toBe(true)
  expect(wait).not.toHaveBeenCalled()
  expect(writes.filter((data) => data.endsWith('\r'))).toHaveLength(1)
  expect(submitted).toHaveBeenCalledOnce()
})

it('keeps an accepted combined Enter delivered after a submit callback throws', async () => {
  const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'omp')
  const before = runtime.getTerminalPromptRequestBinding(handle)
  const submitted = vi.fn(() => {
    throw new Error('terminal_handle_stale')
  })
  expect(
    await deliverTerminalAgentLaunchPrompt({
      runtime,
      handle,
      agent: 'omp',
      freshLaunch: false,
      allowBusy: true,
      text: 'once',
      expectedBinding: before,
      onSubmitWritten: submitted
    })
  ).toBe(true)
  expect(writes.filter((data) => data.endsWith('\r'))).toHaveLength(1)
  expect(submitted).toHaveBeenCalledOnce()
})

it.each(['answer', 'revoke'] as const)(
  'busy reuse holds permission until %s without waiting for idle',
  async (action) => {
    vi.useFakeTimers()
    const controller = new AbortController()
    try {
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        () => {},
        'codex'
      )
      runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())
      const wait = vi.spyOn(runtime, 'waitForTerminal')
      const sent = deliverTerminalAgentLaunchPrompt({
        runtime,
        handle,
        agent: 'codex',
        freshLaunch: false,
        allowBusy: true,
        text: 'permission held followup',
        signal: controller.signal,
        expectedBinding: runtime.getTerminalPromptRequestBinding(handle)
      })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(writes).toEqual([])
      expect(wait).not.toHaveBeenCalled()
      if (action === 'revoke') {
        controller.abort()
      }
      runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
      await vi.runAllTimersAsync()
      expect(await sent).toBe(action === 'answer')
      expect(writes.filter((data) => data.includes('permission held followup'))).toHaveLength(
        action === 'answer' ? 1 : 0
      )
    } finally {
      controller.abort()
      vi.useRealTimers()
    }
  }
)
