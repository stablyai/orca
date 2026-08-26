import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_SUBMIT_DELAY_MS
} from '../../shared/agent-prompt-injection'
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

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
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

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
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
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
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
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
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
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    const rejected = expect(submission).rejects.toThrow('agent_prompt_blocked')

    await vi.runAllTimersAsync()

    await rejected
    expect(writes).not.toContain('\r')
  })

  it('does not paste into an existing permission prompt', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())

    await expect(runtime.sendTerminalAgentPrompt(handle, 'review this')).rejects.toThrow(
      'agent_prompt_blocked'
    )
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

    await expect(runtime.sendTerminalAgentPrompt(handle, 'review this')).rejects.toThrow(
      'agent_prompt_blocked'
    )
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

    await expect(runtime.sendTerminalAgentPrompt(handle, 'review this')).rejects.toThrow(
      'agent_prompt_blocked'
    )
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

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
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

    await expect(runtime.sendTerminalAgentPrompt(handle, 'review this')).rejects.toThrow(
      'agent_prompt_blocked'
    )
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

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
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
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
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
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    const rejected = expect(submission).rejects.toThrow('agent_prompt_blocked')

    await vi.runAllTimersAsync()

    await rejected
    expect(writes).not.toContain('\r')
  })

  it('stops a chunked paste when permission appears between chunks', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    let writeChecks = 0

    const submission = runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(20_000), {
      beforeWrite: () => {
        writeChecks += 1
        if (writeChecks === 2) {
          runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())
        }
      }
    })

    await expect(submission).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toHaveLength(2)
    expect(writes[1]).toBe(AGENT_PROMPT_BRACKETED_PASTE_END)
    expect(writes).not.toContain('\r')
  })

  it('stops a chunked paste after transient output-only permission', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.onPtyData('pty-prompt', 'initial output\n', Date.now())
    let writeChecks = 0

    const submission = runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(20_000), {
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
    expect(writes).toHaveLength(2)
    expect(writes[1]).toBe(AGENT_PROMPT_BRACKETED_PASTE_END)
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

    await expect(runtime.sendTerminalAgentPrompt(handle, 'review this')).rejects.toThrow(
      'agent_prompt_blocked'
    )
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

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
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

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('does not treat an unchanged newer working status as submission evidence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData(
          'pty-prompt',
          '\x1b]9999;{"state":"working","agentType":"aider"}\x07',
          Date.now()
        )
      }
    })
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())
    vi.setSystemTime(2_000)
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"working","agentType":"aider"}\x07',
      Date.now()
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    const rejected = expect(submission).rejects.toThrow('agent_prompt_stalled')
    await vi.runAllTimersAsync()

    await rejected
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('does not write Enter after the PTY generation changes during settlement', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    const rejected = expect(submission).rejects.toThrow('terminal_handle_stale')

    await vi.advanceTimersByTimeAsync(0)
    expect(writes.some((data) => data.includes(AGENT_PROMPT_BRACKETED_PASTE_END))).toBe(true)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      runtime.getPtyOutputSequence('pty-prompt')
    )
    await vi.runAllTimersAsync()

    await rejected
    expect(writes).not.toContain('\r')
  })

  it('does not reuse explicit permission status across a provider generation reset', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'continued' },
      0
    )
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"waiting","agentType":"aider"}\x07',
      Date.now()
    )
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      0
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      signal: controller.signal
    })
    const rejected = expect(submission).rejects.toThrow('request_aborted')
    await vi.advanceTimersByTimeAsync(0)

    expect(writes.some((data) => data.includes(AGENT_PROMPT_BRACKETED_PASTE_END))).toBe(true)
    controller.abort()
    await vi.runAllTimersAsync()
    await rejected
  })

  it('does not reuse output-only permission across a provider generation reset', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
      }
    })
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'continued' },
      0
    )
    runtime.onPtyData(
      'pty-prompt',
      'Permission required\nAllow once\nAllow always\nReject\n',
      Date.now()
    )
    const sequenceAtSpawnStart = runtime.getPtyOutputSequence('pty-prompt')
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      sequenceAtSpawnStart
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('fails closed when new bytes race a reset after old permission output', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'continued' },
      0
    )
    runtime.onPtyData(
      'pty-prompt',
      'Permission required\nAllow once\nAllow always\nReject\n',
      Date.now()
    )
    const sequenceAtSpawnStart = runtime.getPtyOutputSequence('pty-prompt')
    runtime.onPtyData('pty-prompt', 'replacement startup output\n', Date.now())
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      sequenceAtSpawnStart
    )

    await expect(runtime.sendTerminalAgentPrompt(handle, 'review this')).rejects.toThrow(
      'agent_prompt_blocked'
    )
    expect(writes).toEqual([])
  })

  it('reports permission reached after the first Enter as blocked', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())
      }
    })
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    const rejected = expect(submission).rejects.toThrow('agent_prompt_blocked')

    await vi.runAllTimersAsync()

    await rejected
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('serializes concurrent prompt submissions within one PTY generation', async () => {
    vi.useFakeTimers()
    let enterCount = 0
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        enterCount += 1
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
      }
    })

    const first = runtime.sendTerminalAgentPrompt(handle, 'first prompt')
    const second = runtime.sendTerminalAgentPrompt(handle, 'second prompt')
    await vi.runAllTimersAsync()
    await Promise.all([first, second])

    const firstPaste = writes.findIndex((data) => data.includes('first prompt'))
    const firstEnter = writes.indexOf('\r', firstPaste + 1)
    const secondPaste = writes.findIndex((data) => data.includes('second prompt'))
    const secondEnter = writes.indexOf('\r', secondPaste + 1)
    expect(firstPaste).toBeGreaterThanOrEqual(0)
    expect(firstEnter).toBeGreaterThan(firstPaste)
    expect(secondPaste).toBeGreaterThan(firstEnter)
    expect(secondEnter).toBeGreaterThan(secondPaste)
    expect(enterCount).toBe(2)
  })

  it('does not queue a replacement generation behind an obsolete submission', async () => {
    vi.useFakeTimers()
    let releaseFirst!: () => void
    let firstWriteReached!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      firstWriteReached = resolve
    })
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
      }
    })

    const first = runtime.sendTerminalAgentPrompt(handle, 'obsolete prompt', {
      beforeWrite: async () => {
        firstWriteReached()
        await firstGate
      }
    })
    await firstWrite
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      0
    )

    const replacement = runtime.sendTerminalAgentPrompt(handle, 'replacement prompt')
    await vi.runAllTimersAsync()
    await expect(replacement).resolves.toMatchObject({ accepted: true })
    expect(writes.some((data) => data.includes('replacement prompt'))).toBe(true)

    releaseFirst()
    await expect(first).rejects.toThrow('terminal_handle_stale')
  })

  it('does not close a partial paste after the PTY generation changes', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    let writeChecks = 0

    const submission = runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(20_000), {
      beforeWrite: () => {
        writeChecks += 1
        if (writeChecks === 2) {
          runtime.synchronizePtyOutputSequenceFromProvider(
            'pty-prompt',
            { value: 0, generation: 'reset' },
            runtime.getPtyOutputSequence('pty-prompt')
          )
        }
      }
    })

    await expect(submission).rejects.toThrow('terminal_handle_stale')
    expect(writes).toHaveLength(1)
    expect(writes[0]).not.toContain(AGENT_PROMPT_BRACKETED_PASTE_END)
  })

  it('does not send delayed Enter after cancellation during settlement', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      signal: controller.signal
    })
    const rejected = expect(submission).rejects.toThrow('request_aborted')

    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await vi.runAllTimersAsync()

    await rejected
    expect(writes.filter((data) => data === '\r')).toHaveLength(0)
  })

  it('does not send another Enter after cancellation during verification', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      signal: controller.signal
    })
    const rejected = expect(submission).rejects.toThrow('request_aborted')

    // Why: the submit delay is 1_500 on Windows (ConPTY); a hardcoded 500 aborts before the Enter there.
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS)
    // Why: pin the phase boundary so drift fails here instead of as an empty post-abort array.
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    controller.abort()
    await vi.runAllTimersAsync()

    await rejected
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })
})
