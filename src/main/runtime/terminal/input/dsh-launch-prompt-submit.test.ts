import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../../../shared/agent-prompt-injection'
import type { RuntimeTerminalSend } from '../../../../shared/runtime-types'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { createAgentPromptSubmissionRuntime } from '../../agent-prompt-submission-runtime-test-fixture'

vi.mock('../../../git/worktree', () => ({
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

// Why: dsh-tui 0.17.0 draws its launchpad `❯` before the startup session is live; Enter in that
// window is refused ("still starting — press Enter once it is ready") and the draft stays. Measured
// against the real TUI: Enter at +50…800 ms after the glyph is dropped, +1000 ms submits.
const DSH_WORKING_TITLE = '\x1b]0;⠂ 🐋 Task title\x07'

const launchOptions = {
  inputKind: 'launch' as const,
  // Exactly what agent.launch passes for a fresh terminal launch.
  composerReady: true,
  acceptQueued: true,
  requestId: 'request-1',
  observationTimeoutMs: 0
}

function launch(
  runtime: OrcaRuntimeService,
  handle: string,
  prompt: string
): ReturnType<OrcaRuntimeService['sendTerminalAgentPrompt']> {
  return runtime.sendTerminalAgentPrompt(handle, prompt, launchOptions)
}

function enters(writes: readonly string[]): number {
  return writes.filter((data) => data === '\r').length
}

function pastes(writes: readonly string[]): string[] {
  return writes.filter((data) => data.includes(AGENT_PROMPT_BRACKETED_PASTE_END))
}

describe('dsh launch prompt submit readiness', () => {
  afterEach(() => vi.useRealTimers())

  it('retries only Enter until the launchpad starts the turn', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        // The third Enter lands after the startup session opened; the first two are refused.
        if (data === '\r' && writes.filter((written) => written === '\r').length === 3) {
          runtime.onPtyData('pty-prompt', DSH_WORKING_TITLE, Date.now())
        }
      },
      'dsh'
    )

    const submission = launch(runtime, handle, 'Review the launch prompt path')
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(enters(writes)).toBe(3)
    expect(pastes(writes)).toHaveLength(1)
  })

  it('stops at the configured retry budget without pasting the prompt again', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'dsh')

    const submission = launch(runtime, handle, 'Review the launch prompt path')
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(enters(writes)).toBe(1 + TUI_AGENT_CONFIG.dsh.submitRetryUntilTurnStart!.attempts)
    expect(pastes(writes)).toHaveLength(1)
  })

  it('keeps a single Enter for an agent without the retry policy', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'aider')

    const submission = launch(runtime, handle, 'Review the launch prompt path')
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(enters(writes)).toBe(1)
    expect(pastes(writes)).toHaveLength(1)
  })

  it('retries the same way for a long multi-line task and pastes it once', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data === '\r' && writes.filter((written) => written === '\r').length === 3) {
          runtime.onPtyData('pty-prompt', DSH_WORKING_TITLE, Date.now())
        }
      },
      'dsh'
    )
    const prompt = Array.from(
      { length: 40 },
      (_, index) =>
        `Step ${index + 1}: inspect the launch prompt delivery path and report findings.`
    ).join('\n')

    const submission = launch(runtime, handle, prompt)
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(enters(writes)).toBe(3)
    const paste = pastes(writes)
    expect(paste).toHaveLength(1)
    expect(paste[0]).toContain('Step 40:')
    expect(paste[0]).not.toContain('Review the launch prompt path')
  })

  it('counts every retry Enter in the acceptance checkpoint bytes', async () => {
    vi.useFakeTimers()
    const checkpoints: RuntimeTerminalSend[] = []
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data === '\r' && writes.filter((written) => written === '\r').length === 3) {
          runtime.onPtyData('pty-prompt', DSH_WORKING_TITLE, Date.now())
        }
      },
      'dsh'
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'Review the launch prompt path', {
      ...launchOptions,
      onInputAccepted: (checkpoint) => checkpoints.push(checkpoint)
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0].bytesWritten).toBe(Buffer.byteLength(writes[0], 'utf8') + enters(writes))
  })

  it('does not send the retry Enter when the write guard cancels the request', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let guards = 0
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'dsh')

    const submission = runtime.sendTerminalAgentPrompt(handle, 'Review the launch prompt path', {
      ...launchOptions,
      signal: controller.signal,
      beforeWrite: async () => {
        guards += 1
        // Third call: the guard ahead of the first retry Enter.
        if (guards === 3) {
          controller.abort()
        }
      }
    })
    const rejected = expect(submission).rejects.toThrow('request_aborted')
    await vi.runAllTimersAsync()

    await rejected
    expect(enters(writes)).toBe(1)
    expect(pastes(writes)).toHaveLength(1)
  })

  it('does not send the retry Enter when the turn starts while the guard is pending', async () => {
    vi.useFakeTimers()
    let guards = 0
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'dsh')

    const submission = runtime.sendTerminalAgentPrompt(handle, 'Review the launch prompt path', {
      ...launchOptions,
      beforeWrite: async () => {
        guards += 1
        if (guards === 3) {
          runtime.onPtyData('pty-prompt', DSH_WORKING_TITLE, Date.now())
        }
      }
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(enters(writes)).toBe(1)
  })
})
