import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../shared/agent-prompt-injection'
import {
  AGENT_PROMPT_TEST_WORKTREE_PATH,
  createAgentPromptSubmissionRuntime
} from './agent-prompt-submission-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

const createPromptRuntime = createAgentPromptSubmissionRuntime

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

describe('agent prompt submission runtime', () => {
  afterEach(() => vi.useRealTimers())

  it('submits exactly once after an observed lifecycle transition', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data === '\r') {
          runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
        }
      }
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('accepts a working-to-idle cycle completed before the first poll', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
      }
    })

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('reports redraw-only activity as stalled without retrying Enter', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
        runtime.onPtyData('pty-prompt', '\x1b[2J\x1b[H› review this', Date.now())
      } else if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b[2J\x1b[H› review this', Date.now())
      }
    })
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    const rejected = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.runAllTimersAsync()

    await rejected
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('reports a neutral title transition as stalled without retrying Enter', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b]0;plain shell\x07', Date.now())
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
      }
    })
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    const rejected = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.runAllTimersAsync()

    await rejected
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('does not send Enter after a permission state appears', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())
      }
    })
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    const rejected = expect(submission).rejects.toThrow('agent_prompt_blocked')

    await vi.runAllTimersAsync()

    await rejected
    expect(writes).not.toContain('\r')
  })

  it('does not paste into an existing permission prompt', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'review this', { inputKind: 'driving' })
    ).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toEqual([])
  })

  it('does not paste into an output-only permission prompt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
    vi.setSystemTime(2_000)
    runtime.onPtyData(
      'pty-prompt',
      'Permission required\nAllow once\nAllow always\nReject\n',
      Date.now()
    )

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'review this', { inputKind: 'driving' })
    ).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toEqual([])
  })

  it('does not paste into a coalesced live permission title', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"working","agentType":"aider"}\x07' +
        '\x1b]0;Codex waiting for permission\x07',
      Date.now()
    )

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'review this', { inputKind: 'driving' })
    ).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toEqual([])
  })

  it('does not paste when split status stripping completes a permission title', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
      }
    })
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]0;Codex waiting for permission\x1b]9999;{"state":"working","agentType":"aider"',
      Date.now()
    )
    runtime.onPtyData('pty-prompt', '}\x07\x07', Date.now())

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    const rejected = expect(submission).rejects.toThrow('agent_prompt_blocked')
    await vi.runAllTimersAsync()

    await rejected
    expect(writes).toEqual([])
  })

  it('preserves hook permission after an earlier live idle title', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.onPtyData(
      'pty-prompt',
      'Permission required\nAllow once\nAllow always\nReject\n',
      Date.now()
    )
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"waiting","agentType":"aider"}\x07',
      Date.now()
    )

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'review this', { inputKind: 'driving' })
    ).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toEqual([])
  })

  it('does not block on permission text restored only as history', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
      }
    })
    runtime.seedTerminalRestoreTail('pty-prompt', {
      text: 'Permission required\r\nAllow once\r\nAllow always\r\nReject\r\n'
    })

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('does not send Enter after output-only permission appears during settlement', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
        vi.setSystemTime(2_000)
        runtime.onPtyData(
          'pty-prompt',
          'Permission required\nAllow once\nAllow always\nReject\n',
          Date.now()
        )
      }
    })
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    const rejected = expect(submission).rejects.toThrow('agent_prompt_blocked')

    await vi.runAllTimersAsync()

    await rejected
    expect(writes).not.toContain('\r')
  })

  it.each([
    '\x1b]0;Codex waiting for permission\x07\x1b]0;Codex idle\x07',
    '\x1b]9999;{"state":"working","agentType":"aider"}\x07' +
      '\x1b]0;Codex waiting for permission\x07',
    '\x1b]0;Codex waiting for permission\x07' +
      '\x1b]9999;{"state":"working","agentType":"aider"}\x07'
  ])('does not send Enter after coalesced permission activity', async (output) => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
        runtime.onPtyData('pty-prompt', output, Date.now())
      }
    })
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    const rejected = expect(submission).rejects.toThrow('agent_prompt_blocked')

    await vi.runAllTimersAsync()

    await rejected
    expect(writes).not.toContain('\r')
  })

  it('does not submit an atomic paste after permission appears', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    let writeChecks = 0

    const submission = runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(20_000), {
      inputKind: 'driving',
      beforeWrite: () => {
        writeChecks += 1
        if (writeChecks === 2) {
          runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())
        }
      }
    })

    await expect(submission).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain(AGENT_PROMPT_BRACKETED_PASTE_END)
    expect(writes).not.toContain('\r')
  })

  it('does not submit an atomic paste after transient output-only permission', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.onPtyData('pty-prompt', 'initial output\n', Date.now())
    let writeChecks = 0

    const submission = runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(20_000), {
      inputKind: 'driving',
      beforeWrite: () => {
        writeChecks += 1
        if (writeChecks === 2) {
          runtime.onPtyData(
            'pty-prompt',
            'Permission required\nAllow once\nAllow always\nReject\n',
            Date.now()
          )
          runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
        }
      }
    })

    await expect(submission).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain(AGENT_PROMPT_BRACKETED_PASTE_END)
    expect(writes).not.toContain('\r')
  })

  it('prefers a later permission title over an earlier explicit idle status', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"done","agentType":"aider"}\x07',
      Date.now()
    )
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'review this', { inputKind: 'driving' })
    ).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toEqual([])
  })

  it('prefers later explicit idle evidence over stale permission output', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    let handle = ''
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'prompt-pane',
          terminalHandle: handle,
          state: 'done',
          prompt: '',
          agentType: 'aider',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now()
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-prompt' }),
      write: (_ptyId, data) => {
        writes.push(data)
        if (data === '\r') {
          runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
        }
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    handle = (
      await runtime.createTerminal(`path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`, {
        launchAgent: 'aider'
      })
    ).handle
    runtime.onPtyData(
      'pty-prompt',
      'Permission required\nAllow once\nAllow always\nReject\n' +
        '\x1b]0;Codex waiting for permission\x07',
      Date.now()
    )
    vi.setSystemTime(2_000)

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('prefers a later working title over an earlier explicit idle status', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
      }
    })
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"done","agentType":"aider"}\x07',
      Date.now()
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('does not treat an unchanged newer working status as submission evidence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())
    vi.setSystemTime(2_000)
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"working","agentType":"aider"}\x07',
      Date.now()
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    const rejected = expect(submission).rejects.toThrow('agent_prompt_stalled')
    await vi.runAllTimersAsync()

    await rejected
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  // Why (#16095): a still-working agent can never produce a `→working` edge, so the old predicate
  // was unsatisfiable for every follow-up prompt; pane output after Enter is the evidence left.
  it('accepts pane output after Enter while the agent is already working', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', 'queued for the current turn', Date.now())
      }
    })
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"working","agentType":"aider"}\x07',
      Date.now()
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('keeps a queued receipt pending when only the existing turn emits output', async () => {
    vi.useFakeTimers()
    const { runtime, handle } = await createAgentPromptSubmissionRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', 'output from the existing turn', Date.now())
      }
    }, 'codex')
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"working","agentType":"aider"}\x07',
      Date.now()
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'queued-output-only',
      observationTimeoutMs: 0
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({
      prompt: { stages: ['input_accepted'] }
    })
  })

  // Why: hook rows reach the runtime through this provider, which has no window and no OSC title —
  // the same path a headless `orca serve` host and a minimized desktop window take.
})
