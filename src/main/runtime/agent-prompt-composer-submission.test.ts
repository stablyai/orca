import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../shared/agent-prompt-injection'
import {
  AGENT_PROMPT_COMPOSER_READY_TIMEOUT_MS,
  AGENT_PROMPT_EFFECT_TIMEOUT_MS,
  AGENT_PROMPT_PENDING_COMPOSER_GRACE_MS
} from '../../shared/orchestration-timing-budgets'
import { AGENT_PROMPT_SUBMIT_RETRY_DELAYS_MS } from './agent-prompt-submission-verification'
import {
  AGENT_PROMPT_TEST_WORKTREE_PATH,
  createAgentPromptSubmissionRuntime
} from './agent-prompt-submission-runtime-test-fixture'

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

const PTY = 'pty-prompt'
const PROMPT =
  'You are working on task task_123 for dispatch ctx_456.\n\nSend worker_done when done.'
const CLEAR_SCREEN = '\x1b[2J\x1b[H'
const BRACKETED_PASTE_ON = '\x1b[?2004h'

// Why: the shape Codex paints once its model is loaded — header, composer glyph, footer.
function codexFrame(composer: string, model = 'gpt-5.6-sol medium'): string {
  return (
    `${CLEAR_SCREEN}\x1b[?25h >_ OpenAI Codex (v0.152.0)\r\n` +
    ` model:       ${model}\r\n` +
    ` directory:   ${AGENT_PROMPT_TEST_WORKTREE_PATH}\r\n\r\n` +
    `› ${composer}\r\n\r\n` +
    ` gpt-5.6-sol · 100% context left\r\n`
  )
}

function enters(writes: string[]): number {
  return writes.filter((data) => data === '\r').length
}

describe('agent prompt submission observes the composer', () => {
  afterEach(() => vi.useRealTimers())

  it('re-sends Enter while the pasted payload stays parked, then accepts the turn start', async () => {
    vi.useFakeTimers()
    let enterCount = 0
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          runtime.onPtyData(PTY, codexFrame('[Pasted Content 5033 chars]'), Date.now())
        } else if (data === '\r') {
          enterCount += 1
          // Why: the first Enter is absorbed into the paste burst and only repaints the placeholder.
          runtime.onPtyData(
            PTY,
            enterCount === 1
              ? codexFrame('[Pasted Content 5033 chars]')
              : `${codexFrame('')}\x1b]0;Codex working\x07`,
            Date.now()
          )
        }
      },
      'codex',
      { seedReadyHeader: false }
    )
    runtime.onPtyData(PTY, `${BRACKETED_PASTE_ON}${codexFrame('')}`, Date.now())

    const submission = runtime.sendTerminalAgentPrompt(handle, PROMPT)
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(enters(writes)).toBe(2)
  })

  it('accepts a visible payload that disappears after Enter, with no hook or title evidence', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          runtime.onPtyData(PTY, codexFrame(PROMPT.split('\n')[0]!), Date.now())
        } else if (data === '\r') {
          runtime.onPtyData(PTY, codexFrame(''), Date.now())
        }
      },
      'codex',
      { seedReadyHeader: false }
    )
    runtime.onPtyData(PTY, `${BRACKETED_PASTE_ON}${codexFrame('')}`, Date.now())

    const submission = runtime.sendTerminalAgentPrompt(handle, PROMPT)
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(enters(writes)).toBe(1)
  })

  // Why (field, 2026-09-01): two Codex dispatches came back input_accepted while the payload sat
  // as `[Pasted Content N chars]` for four hours — the agent was already `working` from its session
  // hook and kept painting, so output-after-Enter passed as delivery evidence.
  it('does not accept a busy agent painting around a parked payload; re-sends Enter until it clears', async () => {
    vi.useFakeTimers()
    let enterCount = 0
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          runtime.onPtyData(PTY, codexFrame('[Pasted Content 4087 chars]'), Date.now())
        } else if (data === '\r') {
          enterCount += 1
          runtime.onPtyData(
            PTY,
            enterCount === 1 ? codexFrame('[Pasted Content 4087 chars]') : codexFrame(''),
            Date.now()
          )
        }
      },
      'codex',
      { seedReadyHeader: false }
    )
    runtime.onPtyData(
      PTY,
      `${BRACKETED_PASTE_ON}${codexFrame('')}\x1b]0;Codex working\x07`,
      Date.now()
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, PROMPT)
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(enters(writes)).toBe(2)
  })

  it('keeps re-sending Enter with backoff and only then reports a parked payload as stalled', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END) || data === '\r') {
          runtime.onPtyData(PTY, codexFrame('[Pasted Content 5033 chars]'), Date.now())
        }
      },
      'codex',
      { seedReadyHeader: false }
    )
    runtime.onPtyData(PTY, `${BRACKETED_PASTE_ON}${codexFrame('')}`, Date.now())

    const submission = runtime.sendTerminalAgentPrompt(handle, PROMPT)
    const rejected = expect(submission).rejects.toMatchObject({
      message: 'agent_prompt_stalled',
      composer: 'pending',
      enterRetries: AGENT_PROMPT_SUBMIT_RETRY_DELAYS_MS.length
    })
    await vi.advanceTimersByTimeAsync(
      AGENT_PROMPT_EFFECT_TIMEOUT_MS + AGENT_PROMPT_PENDING_COMPOSER_GRACE_MS + 15_000
    )

    await rejected
    expect(enters(writes)).toBe(1 + AGENT_PROMPT_SUBMIT_RETRY_DELAYS_MS.length)
  })

  it('reports an empty composer with no activity as stalled after exactly one Enter', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END) || data === '\r') {
          runtime.onPtyData(PTY, codexFrame(''), Date.now())
        }
      },
      'codex',
      { seedReadyHeader: false }
    )
    runtime.onPtyData(PTY, `${BRACKETED_PASTE_ON}${codexFrame('')}`, Date.now())

    const submission = runtime.sendTerminalAgentPrompt(handle, PROMPT)
    const rejected = expect(submission).rejects.toMatchObject({
      message: 'agent_prompt_stalled',
      composer: 'clear',
      enterRetries: 0
    })
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_EFFECT_TIMEOUT_MS + 15_000)

    await rejected
    expect(enters(writes)).toBe(1)
  })

  it('holds the paste until a booting TUI shows its composer', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          runtime.onPtyData(PTY, codexFrame('[Pasted Content 5033 chars]'), Date.now())
        } else if (data === '\r') {
          runtime.onPtyData(PTY, `${codexFrame('')}\x1b]0;Codex working\x07`, Date.now())
        }
      },
      'codex',
      { seedReadyHeader: false }
    )
    // Why: a splash with no composer yet; the header-based readiness is covered elsewhere.
    runtime.onPtyData(PTY, `${CLEAR_SCREEN}Starting MCP servers (1/2)\r\n`, Date.now())

    const submission = runtime.sendTerminalAgentPrompt(handle, PROMPT)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes).toEqual([])

    runtime.onPtyData(PTY, `${BRACKETED_PASTE_ON}${codexFrame('')}`, Date.now())
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.length).toBeGreaterThan(0)
  })

  it('pastes anyway once the composer readiness budget runs out', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data === '\r') {
          runtime.onPtyData(PTY, '\x1b]0;Codex working\x07', Date.now())
        }
      },
      'codex',
      { seedReadyHeader: false }
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, PROMPT)
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_COMPOSER_READY_TIMEOUT_MS - 1_000)
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(1_100)
    expect(writes.length).toBeGreaterThan(0)
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
  })

  it('pastes immediately into an agent that already reports a status', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data === '\r') {
          runtime.onPtyData(PTY, '\x1b]0;Codex working\x07', Date.now())
        }
      },
      'codex',
      { seedReadyHeader: false }
    )
    runtime.onPtyData(PTY, '\x1b]0;Codex idle\x07', Date.now())

    const submission = runtime.sendTerminalAgentPrompt(handle, PROMPT)
    await vi.advanceTimersByTimeAsync(10)
    expect(writes.length).toBeGreaterThan(0)
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
  })
})
