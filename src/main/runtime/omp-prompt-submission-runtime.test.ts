import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createAgentPromptSubmissionRuntime as createPromptRuntime } from './agent-prompt-submission-runtime-test-fixture'

const submitted = (text: string): string =>
  `\x1b]777;orca-omp-prompt;submitted;${createHash('sha256').update(text).digest('hex')}\x07`

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

describe('OMP prompt submission runtime', () => {
  afterEach(() => vi.useRealTimers())

  it('waits for OMP submit readiness instead of its early idle title', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', submitted('review this'), Date.now())
      }
    }, 'omp')
    runtime.onPtyData('pty-prompt', '\x1b]0;π > test\x07', Date.now())
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    const observed = submission.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(writes).toEqual([])

    runtime.onPtyData('pty-prompt', '\x1b]777;orca-omp-prompt;ready\x07', Date.now())
    await vi.runAllTimersAsync()
    await expect(observed).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('does not resolve OMP idle before submit readiness or after a restart', async () => {
    vi.useFakeTimers()
    const { runtime, handle } = await createPromptRuntime(() => {}, 'omp')
    runtime.onPtyData('pty-prompt', '\x1b]0;π > test\x07', Date.now())
    const controller = new AbortController()
    const wait = runtime.waitForTerminal(handle, {
      condition: 'tui-idle',
      signal: controller.signal
    })
    let resolved = false
    void wait.then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(resolved).toBe(false)
    runtime.onPtyData('pty-prompt', '\x1b]777;orca-omp-prompt;ready\x07', Date.now())
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(wait).resolves.toMatchObject({ satisfied: true })

    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      runtime.getPtyOutputSequence('pty-prompt')
    )
    runtime.onPtyData('pty-prompt', '\x1b]0;π > test\x07', Date.now())
    const next = runtime.waitForTerminal(handle, {
      condition: 'tui-idle',
      signal: controller.signal
    })
    const rejected = expect(next).rejects.toThrow('request_aborted')
    await vi.advanceTimersByTimeAsync(1_000)
    controller.abort()
    await rejected
  })

  it.each(['cancel', 'timeout', 'generation'] as const)(
    'writes nothing when OMP readiness ends by %s',
    async (outcome) => {
      vi.useFakeTimers()
      const { runtime, handle, writes } = await createPromptRuntime(() => {}, 'omp')
      const controller = new AbortController()
      const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
        signal: controller.signal
      })
      const rejected = expect(submission).rejects.toThrow(
        {
          cancel: 'request_aborted',
          timeout: 'agent_prompt_not_ready',
          generation: 'terminal_handle_stale'
        }[outcome]
      )
      await vi.advanceTimersByTimeAsync(1_000)
      if (outcome === 'cancel') {
        controller.abort()
      }
      if (outcome === 'generation') {
        runtime.synchronizePtyOutputSequenceFromProvider(
          'pty-prompt',
          { value: 0, generation: 'reset' },
          runtime.getPtyOutputSequence('pty-prompt')
        )
      }
      await vi.runAllTimersAsync()
      await rejected
      expect(writes).toEqual([])
    }
  )

  it('does not treat OMP readiness as proof of prompt acceptance', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime(() => {}, 'omp')
    runtime.onPtyData('pty-prompt', '\x1b]777;orca-omp-prompt;ready\x07', Date.now())
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    const rejected = expect(submission).rejects.toThrow('agent_prompt_stalled')
    await vi.runAllTimersAsync()
    await rejected
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('accepts explicit OMP input acceptance without status hooks or working titles', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', submitted('review this'), Date.now())
      }
    }, 'omp')
    runtime.onPtyData('pty-prompt', '\x1b]777;orca-omp-prompt;ready\x07', Date.now())
    const observed = runtime
      .sendTerminalAgentPrompt(handle, 'review this')
      .catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    await expect(observed).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('does not reuse OMP input acceptance from before the current prompt', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime(() => {}, 'omp')
    runtime.onPtyData(
      'pty-prompt',
      `${submitted('review this')}\x1b]777;orca-omp-prompt;ready\x07`,
      Date.now()
    )
    const observed = runtime
      .sendTerminalAgentPrompt(handle, 'review this')
      .catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    await expect(observed).resolves.toMatchObject({ message: 'agent_prompt_stalled' })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('correlates the actual sanitized and composer-normalized paste text', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', submitted('中文é 🐳\nL2\nL3   TBVU<ESC>X'), Date.now())
      }
    }, 'omp')
    runtime.onPtyData('pty-prompt', '\x1b]777;orca-omp-prompt;ready\x07', Date.now())
    const observed = runtime
      .sendTerminalAgentPrompt(handle, '  中文e\u0301 🐳\r\nL2\rL3\tT\u0007B\u000bV\u001fU\x1bX  ')
      .catch((error) => error)
    await vi.runAllTimersAsync()
    await expect(observed).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it.each(['autonomous-turn', 'different-input'] as const)(
    'does not accept an unrelated OMP %s as the submitted prompt',
    async (kind) => {
      vi.useFakeTimers()
      const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
        if (data === '\r') {
          runtime.onPtyData(
            'pty-prompt',
            [
              '\x1b]0;⠋ OMP\x07',
              '\x1b]9999;{"state":"working","agentType":"omp"}\x07',
              kind === 'autonomous-turn'
                ? '\x1b]777;orca-omp-prompt;submitted\x07'
                : submitted('unrelated autonomous text')
            ].join(''),
            Date.now()
          )
        }
      }, 'omp')
      runtime.onPtyData('pty-prompt', '\x1b]777;orca-omp-prompt;ready\x07', Date.now())
      const observed = runtime
        .sendTerminalAgentPrompt(handle, 'review this')
        .catch((error) => error)
      await vi.runAllTimersAsync()
      await expect(observed).resolves.toMatchObject({ message: 'agent_prompt_stalled' })
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    }
  )

  it('preserves transient permission evidence across the OMP readiness wait', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime(() => {}, 'omp')
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    const observed = submission.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10)
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"waiting","agentType":"omp"}\x07' +
        '\x1b]9999;{"state":"done","agentType":"omp"}\x07' +
        '\x1b]777;orca-omp-prompt;ready\x07',
      Date.now()
    )
    await vi.runAllTimersAsync()
    await expect(observed).resolves.toMatchObject({ message: 'agent_prompt_blocked' })
    expect(writes).toEqual([])
  })

  it('does not send Enter when OMP startup readiness is revoked during paste', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime) => {
      runtime.onPtyData('pty-prompt', '\x1b]777;orca-omp-prompt;blocked\x07', Date.now())
    }, 'omp')
    runtime.onPtyData('pty-prompt', '\x1b]777;orca-omp-prompt;ready\x07', Date.now())
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    const rejected = expect(submission).rejects.toThrow('agent_prompt_not_ready')
    await vi.runAllTimersAsync()
    await rejected
    expect(writes.filter((data) => data === '\r')).toHaveLength(0)
  })
})
